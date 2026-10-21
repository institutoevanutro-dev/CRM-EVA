/**
 * O MOTIVO DA PASSAGEM ACIONADA PELA FERRAMENTA DO MODELO.
 *
 * Uma etapa que precisa da equipe (concluir um agendamento já coletado) não é
 * "o cliente pediu um atendente". Sem `motivo_codigo`, o `last_handoff_reason`
 * gravado era sempre `requested_human` — e é ele que decide a frase do aviso
 * posterior ao cliente (`motivoDoAviso`) e o "Motivo:" da Central.
 *
 * Portado do projeto original (DeskcommCRM, PR #3068 de @vitor-licassali),
 * adaptado: este fork não tem o briefing nem o registro da passagem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect: vi.fn(async () => {}) }));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ frase: "A equipe dará continuidade." })),
}));
vi.mock("@/lib/leads/agent-activity", () => ({ emitAgentActivityForContact: vi.fn(async () => true) }));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ cancelPendingCronsForLead: vi.fn(async () => {}) }));

import { applyRequestHumanHandoff, requestHumanHandoffInputSchema } from "@/lib/agent-engine/agent/human-handoff";
import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";

const ids = { tenantId: "org-teste", leadId: "contato-teste", conversationId: "conversa-teste" };
const consultas: Array<{ sql: string; params: readonly unknown[] }> = [];
const db = {
  query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    consultas.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }),
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

const passar = (payload: unknown) =>
  applyRequestHumanHandoff(db as never, ids, { conversationSummary: "resumo", avisoAoLead: { avisado: true }, log: log as never }, payload);

const motivoGravado = () => consultas.find(({ sql }) => /update conversations/.test(sql))?.params[3];

describe("o motivo da passagem acionada pela ferramenta", () => {
  beforeEach(() => {
    consultas.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    { payload: {}, gravado: "requested_human" },
    { payload: { reason: "Texto do chamador antigo" }, gravado: "Texto do chamador antigo" },
    { payload: { motivo_codigo: "requested_human" }, gravado: "requested_human" },
    { payload: { motivo_codigo: "critical_stage" }, gravado: "critical_stage" },
    { payload: { motivo_codigo: "critical_stage", reason: "Conclusão pela equipe" }, gravado: "Conclusão pela equipe" },
  ])("⭐ $payload grava $gravado", async ({ payload, gravado }) => {
    expect((await passar(payload)).ok).toBe(true);
    expect(motivoGravado()).toBe(gravado);
  });

  it.each(["inventado", "orcamento_de_ia", "suspected_optout", "", null, 1])(
    "recusa motivo inválido ou reservado %j antes de qualquer efeito",
    async (motivo_codigo) => {
      expect(await passar({ motivo_codigo })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
      expect(db.query).not.toHaveBeenCalled();
    },
  );

  it("não aceita IDs forjados junto com um motivo válido", async () => {
    expect(await passar({ motivo_codigo: "critical_stage", tenantId: "outra-org" })).toMatchObject({ ok: false });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("o lado que o modelo lê conhece as duas opções e quando NÃO usar etapa crítica", () => {
    const forma = (AGENT_TOOL_DEFS.request_human_handoff.inputSchema as unknown as { shape: Record<string, z.ZodType> }).shape;
    const descricao = forma.motivo_codigo?.description ?? "";
    expect(descricao).toContain("requested_human");
    expect(descricao).toContain("critical_stage");
    expect(descricao).toContain("Não use critical_stage só porque o cliente mencionou agendamento");
    expect(Object.keys(forma).sort()).toEqual(Object.keys(requestHumanHandoffInputSchema.shape).sort());
  });
});
