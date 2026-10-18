/**
 * Ações SEM MENSAGEM num fluxo de follow-up: "mover lead no funil" e
 * "etiqueta do lead" (pôr ou tirar).
 *
 * O que se mede:
 *  1. o grafo com `move_lead` / `edit_lead_tag` parseia (antes, a union fechada
 *     recusava), avança no MESMO tick e chama a escrita da casa — uma vez só;
 *  2. o replay do passo (idempotency_key já gravada) NÃO escreve de novo;
 *  3. o adaptador de produção move o negócio do funil da etapa (não o mais
 *     recente de outro funil), nunca o de outra organização, e audita;
 *  4. tirar etiqueta tira só as pedidas e não regrava nada quando não há o que tirar;
 *  5. o publish exige a escolha (etapa ativa, etiqueta escrita);
 *  6. cada caixa custa 1 tick no teto do motor.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2181 de @webtecnica).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { moveLeadHandler, auditar } = vi.hoisted(() => ({
  moveLeadHandler: vi.fn(async (..._args: unknown[]) => ({})),
  auditar: vi.fn(),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));

import { CUSTO_NO_MOTOR } from "@/lib/followup/custo-no-motor";
import { createSupabaseAdminClient, runFollowupTick, type AdminClient, type TickDeps } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";
const ETAPA_DE_OUTRA_ORG = "44444444-4444-4444-8444-444444444444";

function enrollment(currentNodeId: string): EnrollmentRow {
  const agora = new Date().toISOString();
  return {
    id: "e1",
    organization_id: ORG,
    pointer_id: "p1",
    version_id: "v1",
    contact_id: CONTATO,
    conversation_id: null,
    current_node_id: currentNodeId,
    status: "active",
    next_eval_at: agora,
    claimed_until: null,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    steps_taken: 0,
    outcome: null,
    cancel_reason: null,
    started_at: agora,
    completed_at: null,
    updated_at: agora,
  };
}

function grafo(...nos: Array<{ id: string; type: string; config: unknown }>): unknown {
  return {
    nodes: nos.map((n, i) => ({ ...n, label: `nó ${n.id}`, position: { x: 100 * i, y: 0 } })),
    edges: nos.slice(0, -1).map((n, i) => ({
      id: `e-${n.id}`,
      source: n.id,
      target: nos[i + 1]!.id,
      condition: { type: "always" },
    })),
  };
}
const NO_TRIGGER = { id: "n1", type: "trigger", config: {} };
const NO_FIM = { id: "fim", type: "end", config: { outcome: "converted" } };

function cenario(g: unknown, fila: EnrollmentRow[], replay = false) {
  const chamadas: { mover: unknown[]; editar: unknown[] } = { mover: [], editar: [] };
  const patches: Array<Record<string, unknown>> = [];
  const db: AdminClient = {
    async claimDueEnrollments() {
      return fila.splice(0, fila.length);
    },
    async loadFlowGraph() {
      return flowGraphSchema.parse(g);
    },
    async loadLeadFacts() {
      return { lead_stage: "etapa-a", tags: [], contact_name: "Cliente", custom_fields: {} };
    },
    async loadEnrollmentEvents() {
      return [];
    },
    async insertEnrollmentEvent() {
      return { inserted: !replay };
    },
    async updateEnrollment(_id, _org, patch) {
      patches.push(patch as Record<string, unknown>);
    },
    async moverLeadNoFunil(item) {
      chamadas.mover.push(item);
    },
    async editarTagDoLead(item) {
      chamadas.editar.push(item);
    },
    async loadLastInboundBody() {
      return null;
    },
    async loadFlowPointerName() {
      return null;
    },
    async insertDeadInboxItem() {},
    async persistirRespostaFollowup() {},
  };
  const deps: TickDeps = { db, clock: () => new Date("2026-10-18T12:00:00Z"), enqueueJob: async () => {} };
  return { deps, chamadas, patches };
}

describe("motor: as caixas avançam e escrevem uma vez", () => {
  it("mover no funil: parseia, avança para o fim e chama a escrita de etapa", async () => {
    const c = cenario(grafo(NO_TRIGGER, { id: "n2", type: "move_lead", config: { stage_id: ETAPA } }, NO_FIM), [
      enrollment("n2"),
    ]);
    const r = await runFollowupTick(c.deps);
    expect(r).toMatchObject({ failed: 0, advanced: 1 });
    expect(c.chamadas.mover).toEqual([
      { organization_id: ORG, contact_id: CONTATO, enrollment_id: "e1", config: { stage_id: ETAPA } },
    ]);
    expect(c.patches[0]).toMatchObject({ current_node_id: "fim", steps_taken: 1 });
  });

  it("etiqueta: tirar chega ao adaptador com a operação", async () => {
    const c = cenario(
      grafo(NO_TRIGGER, { id: "n2", type: "edit_lead_tag", config: { tags: ["vip"], operacao: "remover" } }, NO_FIM),
      [enrollment("n2")],
    );
    await runFollowupTick(c.deps);
    expect(c.chamadas.editar).toEqual([
      { organization_id: ORG, contact_id: CONTATO, enrollment_id: "e1", config: { tags: ["vip"], operacao: "remover" } },
    ]);
  });

  it("replay do passo (evento já gravado) não escreve de novo", async () => {
    const c = cenario(
      grafo(NO_TRIGGER, { id: "n2", type: "move_lead", config: { stage_id: ETAPA } }, NO_FIM),
      [enrollment("n2")],
      true,
    );
    await runFollowupTick(c.deps);
    expect(c.chamadas.mover).toEqual([]);
  });

  it("cada caixa custa 1 tick no teto do motor", () => {
    expect(CUSTO_NO_MOTOR.move_lead).toBe(1);
    expect(CUSTO_NO_MOTOR.edit_lead_tag).toBe(1);
  });
});

// ─── Adaptador de produção ──────────────────────────────────────────────────

type Linha = Record<string, unknown>;
function cliente(tabelas: Record<string, Linha[]>, updates: Array<{ tabela: string; valores: Linha }>) {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let ordem: string | null = null;
      let valores: Linha | null = null;
      const linhas = () => {
        const ls = (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
        if (ordem) ls.sort((a, b) => String(b[ordem!]).localeCompare(String(a[ordem!])));
        return ls;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), q),
        order: (coluna: string) => ((ordem = coluna), q),
        limit: () => q,
        update: (v: Linha) => ((valores = v), q),
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          if (valores) updates.push({ tabela, valores });
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

beforeEach(() => {
  moveLeadHandler.mockClear();
  auditar.mockClear();
});

describe("adaptador: mover no funil", () => {
  const tabelas: Record<string, Linha[]> = {
    crm_stages: [
      { id: ETAPA, organization_id: ORG, pipeline_id: "funil-b" },
      { id: ETAPA_DE_OUTRA_ORG, organization_id: OUTRA_ORG, pipeline_id: "funil-x" },
    ],
    crm_leads: [
      // O mais recente do contato está em OUTRO funil — a versão ingênua escolheria ele.
      { id: "lead-a", organization_id: ORG, contact_id: CONTATO, pipeline_id: "funil-a", updated_at: "2026-10-03T12:00:00Z" },
      { id: "lead-b", organization_id: ORG, contact_id: CONTATO, pipeline_id: "funil-b", updated_at: "2026-10-01T12:00:00Z" },
    ],
  };
  const mover = (stage_id: string) =>
    createSupabaseAdminClient(cliente(tabelas, []) as never).moverLeadNoFunil!({
      organization_id: ORG,
      contact_id: CONTATO,
      enrollment_id: "e1",
      config: { stage_id },
    });

  it("move o negócio do funil da etapa, pelo escritor da casa, e audita", async () => {
    await mover(ETAPA);
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(moveLeadHandler.mock.calls[0]?.[2]).toBe("lead-b");
    expect(moveLeadHandler.mock.calls[0]?.[3]).toEqual({ to_stage_id: ETAPA });
    expect(auditar.mock.calls[0]?.[0]).toMatchObject({ action: "followup.flow_lead_moved", organizationId: ORG });
  });

  it("etapa de outra organização não resolve nada e não move", async () => {
    await expect(mover(ETAPA_DE_OUTRA_ORG)).rejects.toThrow("etapa_destino_inexistente");
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });
});

describe("adaptador: tirar etiqueta", () => {
  it("tira só as pedidas e audita; sem o que tirar, não regrava", async () => {
    const updates: Array<{ tabela: string; valores: Linha }> = [];
    const tabelas = {
      crm_leads: [{ id: "lead-1", organization_id: ORG, contact_id: CONTATO, tags: ["vip", "novo"], updated_at: "x" }],
    };
    const admin = createSupabaseAdminClient(cliente(tabelas, updates) as never);
    const item = { organization_id: ORG, contact_id: CONTATO, enrollment_id: "e1" };
    await admin.editarTagDoLead!({ ...item, config: { tags: ["vip"], operacao: "remover" } });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ tabela: "crm_leads", valores: { tags: ["novo"] } });
    expect(auditar.mock.calls[0]?.[0]).toMatchObject({
      action: "followup.flow_tags_changed",
      metadata: { operacao: "remover", tags: ["vip"] },
    });

    await admin.editarTagDoLead!({ ...item, config: { tags: ["inexistente"], operacao: "remover" } });
    expect(updates).toHaveLength(1);
  });
});

describe("publish: a caixa precisa estar configurada", () => {
  const pos = { x: 0, y: 0 };
  const comAcao = (acao: FlowGraph["nodes"][number]): FlowGraph => ({
    nodes: [
      { id: "t1", type: "trigger", label: "Início", position: pos, config: {} },
      acao,
      { id: "fim", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "a", source: "t1", target: acao.id, priority: 0, condition: { type: "always" } },
      { id: "b", source: acao.id, target: "fim", priority: 0, condition: { type: "always" } },
    ],
  });
  const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));
  const mover = (stage_id: string) =>
    comAcao({ id: "m1", type: "move_lead", label: "Mover", position: pos, config: { stage_id } });
  const etapas = new Map([
    [ETAPA, { nome: "Proposta", arquivada: false }],
    [ETAPA_DE_OUTRA_ORG, { nome: "Antiga", arquivada: true }],
  ]);

  it("etapa ativa publica; sem etapa, inexistente ou arquivada, recusa", () => {
    expect(validateFlowForPublish(mover(ETAPA), { etapas })).toEqual({ ok: true });
    expect(codigos(validateFlowForPublish(mover("  ")))).toEqual(["etapa_destino_ausente"]);
    expect(codigos(validateFlowForPublish(mover("55555555-5555-4555-8555-555555555555"), { etapas }))).toEqual([
      "etapa_destino_ausente",
    ]);
    expect(codigos(validateFlowForPublish(mover(ETAPA_DE_OUTRA_ORG), { etapas }))).toEqual(["etapa_destino_arquivada"]);
  });

  it("etiqueta vazia ou em branco recusa; escrita publica", () => {
    const marcar = (tags: string[]) =>
      comAcao({ id: "g1", type: "edit_lead_tag", label: "Tag", position: pos, config: { tags } });
    expect(codigos(validateFlowForPublish(marcar([])))).toEqual(["tag_ausente"]);
    expect(codigos(validateFlowForPublish(marcar(["vip", " "])))).toEqual(["tag_ausente"]);
    expect(validateFlowForPublish(marcar(["vip"]))).toEqual({ ok: true });
  });
});
