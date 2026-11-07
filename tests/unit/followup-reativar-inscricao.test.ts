/**
 * REATIVAR A INSCRIÇÃO ENCERRADA PELA RECUSA DAS REGRAS DO ATENDIMENTO.
 *
 * A trava de repetição cancelava inscrições de pós-consulta com texto fixo
 * legítimo (`MOTIVO_ENVIO_VETADO`). `reativaEnrollment` devolve a MESMA linha ao
 * fluxo — `appointment_id` e `version_id` intactos — no passo recusado ou num
 * sucessor direto, e só nesse caso. Aqui: os 4 critérios de recusa, o caso
 * feliz (com o evento na timeline do motor) e o isolamento entre organizações.
 *
 * O que NÃO prova: RLS de verdade (é a sessão do Postgres; o filtro manual por
 * organização é o que se mede aqui) e o motor recalculando a espera ancorada
 * (isso é de `fimDaEsperaAncorada`, que já tem teste próprio).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/leads/activity-write-failure", () => ({ registraFalhaDeAtividade: vi.fn(async () => undefined) }));
vi.mock("@/lib/followup/retorno-crm", () => ({ resolveAlvoDoRetorno: vi.fn(async () => ({ ok: false })) }));

import { MOTIVO_ENVIO_VETADO } from "@/lib/agent-engine/edge/crm/send-ledger";
import { reativaEnrollment } from "@/lib/followup/intervencao";
import type { FlowGraph } from "@/lib/followup/graph-schema";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const ID = "00000000-0000-4000-8000-000000000001";
const AGORA = new Date("2026-11-07T12:00:00.000Z");

const GRAFO: FlowGraph = {
  nodes: [
    { id: "dia7", type: "action", label: "Dia 7", position: { x: 0, y: 0 }, config: { mode: "text", body: "Oi! Como você está?" } },
    { id: "espera15", type: "wait", label: "Até o dia 15", position: { x: 0, y: 0 }, config: { mode: "fixed", duration_ms: 15 * 86_400_000 } },
    { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "e1", source: "dia7", target: "espera15", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "espera15", target: "fim", priority: 0, condition: { type: "always" } },
  ],
} as FlowGraph;

type Linha = Record<string, unknown>;

/** PostgREST em memória: só o que `intervencao.ts` usa (eq, or, select, maybeSingle, update, insert). */
function banco(enrollment: Linha, versaoExiste = true) {
  const tabelas: Record<string, Linha[]> = {
    followup_enrollments: [enrollment],
    followup_flow_versions: versaoExiste ? [{ id: "v1", organization_id: ORG_A, graph: GRAFO }] : [],
    followup_enrollment_events: [],
  };
  function from(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    const casadas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => (filtros.push((l) => l[col] === v), q),
      or: () => q, // `claimed_until` nulo nos casos daqui
      update: (p: Linha) => ((patch = p), q),
      insert: async (l: Linha) => (tabelas[tabela]!.push(l), { error: null }),
      maybeSingle: async () => { const l = casadas()[0]; return { data: l ? structuredClone(l) : null, error: null }; },
      then: (resolve: (r: { data: Linha[]; error: null }) => unknown) => {
        const linhas = casadas();
        if (patch) for (const l of linhas) Object.assign(l, patch);
        return Promise.resolve(resolve({ data: linhas.map((l) => ({ id: l.id })), error: null }));
      },
    };
    return q;
  }
  return { client: { from } as never, tabelas };
}

const cancelada = (extra: Linha = {}): Linha => ({
  id: ID,
  organization_id: ORG_A,
  status: "cancelled",
  contact_id: "c1",
  pointer_id: "p1",
  version_id: "v1",
  appointment_id: "ap1",
  current_node_id: "dia7",
  next_eval_at: null,
  claimed_until: null,
  steps_taken: 4,
  cancel_reason: MOTIVO_ENVIO_VETADO,
  completed_at: "2026-11-01T11:00:00.000Z",
  ...extra,
});

function deps(client: never, orgId = ORG_A) {
  return { supabase: client, admin: client, orgId, userId: "u1", requestId: "r1", agora: AGORA };
}

describe("reativar a inscrição recusada pelas regras do atendimento", () => {
  it("⭐ caso feliz: volta no passo seguinte, mesma linha, appointment e versão intactos, evento gravado", async () => {
    const { client, tabelas } = banco(cancelada());
    const r = await reativaEnrollment(deps(client), ID, "espera15");
    expect(r.ok).toBe(true);
    const linha = tabelas.followup_enrollments![0]!;
    expect(linha).toMatchObject({
      status: "active",
      current_node_id: "espera15",
      next_eval_at: AGORA.toISOString(),
      steps_taken: 5,
      cancel_reason: null,
      completed_at: null,
      appointment_id: "ap1",
      version_id: "v1",
    });
    expect(tabelas.followup_enrollment_events).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        enrollment_id: ID,
        event_type: "reactivated_manual",
        payload: expect.objectContaining({ from_node_id: "dia7", next_node_id: "espera15", actor_user_id: "u1" }),
      }),
    ]);
  });

  it("sem nó escolhido, volta no passo recusado e consome o passo", async () => {
    const { client, tabelas } = banco(cancelada());
    expect((await reativaEnrollment(deps(client), ID)).ok).toBe(true);
    expect(tabelas.followup_enrollments![0]).toMatchObject({ current_node_id: "dia7", steps_taken: 5, status: "active" });
  });

  const recusas: Array<[string, Linha, boolean, string | undefined, string]> = [
    ["não está cancelada", { status: "active", cancel_reason: null }, true, undefined, "estado_incompativel"],
    ["cancelada por outro motivo", { cancel_reason: "Cancelado por uma pessoa da equipe" }, true, undefined, "estado_incompativel"],
    ["a versão do fluxo sumiu", {}, false, undefined, "estado_incompativel"],
    ["o nó não é sucessor do atual", {}, true, "fim", "caminho_invalido"],
  ];
  for (const [nome, extra, versao, no, codigo] of recusas) {
    it(`recusa: ${nome} — nada muda`, async () => {
      const original = cancelada(extra);
      const { client, tabelas } = banco({ ...original }, versao);
      const r = await reativaEnrollment(deps(client), ID, no);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.codigo).toBe(codigo);
      expect(tabelas.followup_enrollments![0]).toEqual(original);
      expect(tabelas.followup_enrollment_events).toEqual([]);
    });
  }

  it("isolamento: outra organização não acha nem reativa a inscrição", async () => {
    const original = cancelada();
    const { client, tabelas } = banco({ ...original });
    const r = await reativaEnrollment(deps(client, ORG_B), ID);
    expect(r.ok === false && r.codigo).toBe("nao_encontrado");
    expect(tabelas.followup_enrollments![0]).toEqual(original);
    expect(tabelas.followup_enrollment_events).toEqual([]);
  });
});
