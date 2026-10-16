import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClient, runFollowupTick, type AdminClient, type FollowupJobRequest } from "./engine";
import type { FlowGraph } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";
import { FOLGA_DEPOIS_DO_RETORNO_MS, reavaliarDepoisDoRetorno } from "./retorno-segura-o-fluxo";
import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

/**
 * O FLUXO DE SILÊNCIO NÃO FALA POR CIMA DO RETORNO (agendado ou recém-saído).
 *
 * Porte da parte de retorno de b94446a5c (jmpo) e do PR #2929 (@webtecnica,
 * issue #2907) do DeskcommCRM original. O defeito medido lá: o agente agenda o
 * retorno para 18:55, o retorno sai às 18:56:04, a varredura do minuto seguinte
 * inscreve o contato e o "Follow-up 1" sai às 18:58:05: duas mensagens seguidas.
 *
 * Prova: a régua que o PostgREST recebe (fake que grava a cadeia; filtrar é do
 * Postgres), a varredura pulando quem o retorno segura, e a inscrição que já
 * andava segurada sem enfileirar envio. O espelho em SQL mora no invariante.
 */

type Linha = Record<string, unknown>;
type Chamada = { metodo: string; args: unknown[] };

/** Responde por ordem de `from()`; com `porTabela`, só conta as de `cron_jobs`. */
function fakeAdmin(respostas: Linha[][], porTabela: Record<string, Linha | null> = {}) {
  const consultas: Chamada[][] = [];
  let i = 0;
  const from = (tabela: string) => {
    const chamadas: Chamada[] = [{ metodo: "from", args: [tabela] }];
    consultas.push(chamadas);
    const unico = tabela in porTabela;
    const rows = unico ? null : (respostas[i++] ?? []);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) =>
              resolve({ data: unico ? porTabela[tabela] : rows, error: null });
          }
          return (...args: unknown[]) => {
            chamadas.push({ metodo: String(prop), args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as unknown as SupabaseClient, consultas };
}

const HORA = 3_600_000;
const AGORA_REAL = Date.now();
const ha = (ms: number) => new Date(AGORA_REAL - ms).toISOString();

describe("régua do retorno que segura", () => {
  it("⭐ vivo segura; saído há 2 h segura (#2907); saído há 30 h e desligado antes da hora não", async () => {
    const { admin } = fakeAdmin([
      [{ contact_id: "c-vivo", next_run_at: ha(-6 * HORA) }],
      [
        { contact_id: "c-recente", next_run_at: ha(2 * HORA) },
        { contact_id: "c-antigo", next_run_at: ha(30 * HORA) },
        { contact_id: "c-desligado-antes-da-hora", next_run_at: ha(-3 * HORA) },
        { contact_id: null, next_run_at: ha(HORA) },
      ],
    ]);
    const segura = await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org-1");
    expect([...segura].sort()).toEqual(["c-recente", "c-vivo"]);
  });

  it("a consulta do retorno saído: one-shot disparado com sucesso, fora os passos de fluxo, janela de um dia", async () => {
    const { admin, consultas } = fakeAdmin([[], []]);
    await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org-1");
    expect(consultas).toHaveLength(2);
    const [vivo, saido] = consultas as [Chamada[], Chamada[]];
    for (const c of [vivo, saido]) {
      expect(c[0]).toEqual({ metodo: "from", args: ["cron_jobs"] });
      expect(c).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
      expect(c).toContainEqual({ metodo: "eq", args: ["kind", "at"] });
      expect(c).toContainEqual({ metodo: "eq", args: ["job_kind", "followup_turn"] });
      expect(c).toContainEqual({ metodo: "is", args: ["cancelled_at", null] });
      expect(c).toContainEqual({ metodo: "is", args: ["payload->>followup_enrollment_id", null] });
    }
    expect(vivo).toContainEqual({ metodo: "eq", args: ["enabled", true] });
    expect(saido).toContainEqual({ metodo: "eq", args: ["enabled", false] });
    expect(saido).toContainEqual({ metodo: "is", args: ["last_error", null] });
    const gt = saido.find((c) => c.metodo === "gt" && c.args[0] === "next_run_at");
    const lte = saido.find((c) => c.metodo === "lte" && c.args[0] === "next_run_at");
    expect(Math.abs(Date.parse(String(gt?.args[1])) - (Date.now() - FOLGA_DEPOIS_DO_RETORNO_MS))).toBeLessThan(30_000);
    expect(Math.abs(Date.parse(String(lte?.args[1])) - Date.now())).toBeLessThan(30_000);
  });

  it("a regra devolve um dia depois do retorno", () => {
    const r = "2026-09-30T12:00:00.000Z";
    expect(Date.parse(reavaliarDepoisDoRetorno(r)) - Date.parse(r)).toBe(24 * HORA);
  });
});

describe("varredura de silêncio", () => {
  function sweepDb(comRetorno: Set<string>) {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "p-1", organization_id: "org", active_version_id: "v-1", threshold_minutes: 40, segments: [], active_since: "2026-10-01T00:00:00.000Z" },
      ],
      loadSilentContacts: async () =>
        ["contato-com-retorno", "outro"].map((contact_id) => ({
          contact_id,
          ultima_entrada_em: "2026-10-02T10:00:00.000Z",
          ultima_entrada_gravada_em: "2026-10-02T10:00:00.000Z",
        })),
      loadUltimaInscricaoNoPonteiro: async () => new Map<string, string>(),
      loadContatosComInscricaoViva: async () => new Set<string>(),
      loadContatosComRetornoVivo: async () => comRetorno,
      loadContactIdsEmCooldown: async () => new Set<string>(),
      loadTriggerNodeId: async () => "t-1",
      insertEnrollment: insert,
    };
    return { db, insert };
  }
  const deps = {
    gateDb: { loadEnabledPublishedFollowupAgents: async () => [{ agentId: "a-1", pointerIds: ["p-1"] }] },
    clock: () => new Date("2026-10-02T12:00:00Z"),
  };

  it("⭐ #2907: retorno que saiu há 2 h segura, pela régua real; o outro silencioso entra", async () => {
    const { admin } = fakeAdmin([[], [{ contact_id: "contato-com-retorno", next_run_at: ha(2 * HORA) }]]);
    const comRetorno = await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org");
    const { db, insert } = sweepDb(comRetorno);
    const resumo = await runSilenceSweep({ db, ...deps });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "outro" }));
    expect(resumo.skipped_pending_return).toBe(1);
    expect(resumo.enrolled).toBe(1);
  });

  it("controle: sem retorno, os dois entram", async () => {
    const { db, insert } = sweepDb(new Set());
    await runSilenceSweep({ db, ...deps });
    expect(insert).toHaveBeenCalledTimes(2);
  });
});

describe("inscrição que já andava", () => {
  const AGORA = new Date("2026-10-02T12:00:00.000Z");
  const GRAFO: FlowGraph = {
    nodes: [
      { id: "oferta", type: "action", label: "Oferta", position: { x: 0, y: 0 }, config: { mode: "text", body: "oi" } },
      { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
    ],
    edges: [{ id: "oferta-fim", source: "oferta", target: "fim", priority: 0, condition: { type: "always" } }],
  } as FlowGraph;

  function loja(seguraAte: string | null) {
    const enrollment = {
      id: "enr-1", organization_id: "org", pointer_id: "p-1", version_id: "v-1", contact_id: "c-1",
      conversation_id: null, current_node_id: "oferta", status: "active", next_eval_at: AGORA.toISOString(),
      claimed_until: null, attempts: 0, max_attempts: 5, last_error: null, steps_taken: 3, outcome: null,
      cancel_reason: null, started_at: AGORA.toISOString(), completed_at: null, updated_at: AGORA.toISOString(),
    } as EnrollmentRow;
    const eventos: string[] = [];
    const jobs: FollowupJobRequest[] = [];
    const db: AdminClient = {
      retornoQueSeguraOFluxo: async () => seguraAte,
      claimDueEnrollments: async () =>
        enrollment.next_eval_at && Date.parse(enrollment.next_eval_at) <= AGORA.getTime() ? [{ ...enrollment }] : [],
      loadFlowGraph: async () => GRAFO,
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadEnrollmentEvents: async () => [],
      loadLastInboundBody: async () => null,
      async insertEnrollmentEvent(e) {
        eventos.push(e.event_type);
        return { inserted: true };
      },
      async updateEnrollment(_id, _org, patch) {
        Object.assign(enrollment, patch);
      },
      loadFlowPointerName: async () => "Remarketing",
      insertDeadInboxItem: async () => undefined,
      persistirRespostaFollowup: async () => undefined,
    } as AdminClient;
    const tick = () => runFollowupTick({ db, clock: () => AGORA, enqueueJob: async (j) => void jobs.push(j) });
    return { enrollment, eventos, jobs, tick };
  }

  it("⭐ segurada até a data da regra: nada vai para a fila e o dossiê diz por quê", async () => {
    const ate = reavaliarDepoisDoRetorno("2026-10-02T11:00:00.000Z");
    const l = loja(ate);
    await l.tick();
    expect(l.jobs).toHaveLength(0);
    expect(l.enrollment.next_eval_at).toBe(ate);
    expect(l.enrollment.current_node_id).toBe("oferta");
    expect(l.eventos).toEqual(["held_by_return"]);
  });

  it("controle: sem retorno, o mesmo passo enfileira o envio", async () => {
    const l = loja(null);
    await l.tick();
    expect(l.jobs).toHaveLength(1);
    expect(l.eventos).not.toContain("held_by_return");
  });

  it("adapter: retorno saído há 2 h segura fluxo de SILÊNCIO; fluxo por etapa não espera", async () => {
    const saido = ha(2 * HORA);
    const enr = { organization_id: "org", pointer_id: "p-1", contact_id: "c-1" } as EnrollmentRow;
    const silencio = fakeAdmin([[], [{ contact_id: "c-1", next_run_at: saido }]], {
      followup_flow_pointers: { trigger_config: { kind: "silence", params: { threshold_minutes: 40 } } },
    });
    expect(await createSupabaseAdminClient(silencio.admin).retornoQueSeguraOFluxo!(enr)).toBe(
      reavaliarDepoisDoRetorno(saido),
    );
    const etapa = fakeAdmin([[], [{ contact_id: "c-1", next_run_at: saido }]], {
      followup_flow_pointers: { trigger_config: { kind: "stage_change", params: { stage_id: "x" } } },
    });
    expect(await createSupabaseAdminClient(etapa.admin).retornoQueSeguraOFluxo!(enr)).toBeNull();
  });
});
