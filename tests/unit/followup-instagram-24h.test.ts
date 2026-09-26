/**
 * Follow-up no Instagram: dentro das 24h o passo CHEGA ao envio; fora delas o
 * passo é PULADO e o fluxo segue. Nunca cancela, nunca reagenda, nunca reenvia.
 *
 * E o silêncio do bot que o Instagram carrega de propósito (`'infinity'`, para a
 * conversa cair na Fila da equipe) não pode ser lido como "uma pessoa assumiu":
 * se fosse, TODO follow-up do Instagram morreria no gate de handoff. No WhatsApp
 * o silêncio continua bloqueando como sempre.
 *
 * O turno de fluxo é exercitado de ponta a ponta até `runBeforeSend` (texto
 * fixo) e até `runAgentTurn` (mensagem da IA); os gates do núcleo do agente
 * (`isLeadInHandoff`, elegibilidade) e a borda de envio são provados abaixo com
 * pools que respondem como o Postgres.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { CHANNEL_PROVIDER_INSTAGRAM, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

const runBeforeSend = vi.fn(async (_args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  status: "sent",
  outcome: { kind: "sent" },
  trace: [],
}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));

const isLeadInHandoff = vi.fn(async (..._a: unknown[]) => false);
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff }));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock("@/lib/agent-engine/edge/crm/send-message", () => ({ applySendOutcome: vi.fn(async () => undefined) }));

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const ENR = "11111111-1111-4111-8111-111111111111";
const RAZAO = "Passo pulado: fora das 24h do Instagram.";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn", source_event_id: null,
    payload: { followup_enrollment_id: ENR, node_id: "node-1", purpose: "send_message", ...payload, service_boundary: boundary },
    status: "running", priority: 0, run_after: new Date(), attempts: 1, max_attempts: 3, last_error: null,
    locked_by: "w1", locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000);

/** Pool que devolve uma conversa do Instagram, silenciada (como a etapa 2 a deixa). */
function fakePool(conversa: { horas: number; provider?: string; errorCode?: string | null; ledger?: Array<{ status: string; error_code: string | null }> }) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    consultas.push(sql);
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from send_ledger l/.test(sql)) return { rows: conversa.ledger ?? [{ status: "accepted", error_code: null }] };
    if (/select error_code from messages/.test(sql)) return { rows: [{ error_code: conversa.errorCode ?? null }] };
    if (/from conversations/.test(sql)) {
      return { rows: [{
        id: CONVERSA, channel_session_id: CANAL, archived_at: null, bot_silenciado: true,
        provider: conversa.provider ?? CHANNEL_PROVIDER_INSTAGRAM, last_inbound_at: horasAtras(conversa.horas),
      }] };
    }
    if (/from followup_enrollments e\b/.test(sql)) {
      return { rows: [{
        id: ENR, status: "active", started_at: new Date(0), pointer_id: "22222222-2222-4222-8222-222222222222",
        trigger_config: null, appointment_id: null, reserva_criada_em: null, reserva_consulta_em: null, reserva_sujeita_a_sinal: null,
      }] };
    }
    if (/from contacts/.test(sql)) return { rows: [{ is_blocked: false, force_human: false, is_anonymized: false }] };
    if (/from organizations/.test(sql)) return { rows: [{ settings: {} }] };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, consultas };
}

function deps(send = vi.fn(async (..._a: unknown[]) => ({ kind: "sent" }))) {
  const complete = vi.fn(async (..._a: unknown[]) => undefined);
  return {
    complete,
    send,
    deps: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {}, llmCfg: {}, knobs: {},
      channel: () => ({ send }),
      completeFollowupTurn: complete,
    } as never,
  };
}

const ctx = { workerId: "w1" };
let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);
beforeEach(() => {
  runBeforeSend.mockClear();
  runAgentTurn.mockClear();
  isLeadInHandoff.mockClear();
});

const resultado = (complete: ReturnType<typeof vi.fn>) => (complete.mock.calls[0]?.[1] as { result?: unknown } | undefined)?.result;

describe("turno de fluxo — texto fixo", () => {
  it("fora das 24h: pula e segue; não envia, não reagenda, não lança", async () => {
    const { pool, consultas } = fakePool({ horas: 30 });
    const d = deps();
    await expect(criarHandler(d.deps)(job({ fixed_body: "oi" }), pool, ctx)).resolves.toBeUndefined();
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(consultas.some((q) => /cron_jobs/.test(q))).toBe(false);
    expect(resultado(d.complete)).toEqual({ kind: "pulado", reason: RAZAO });
  });

  it("dentro das 24h, com a conversa silenciada (roteamento): chega ao envio, marcado como follow-up", async () => {
    const { pool } = fakePool({ horas: 2 });
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: "oi" }), pool, ctx);
    expect(isLeadInHandoff).toHaveBeenCalledWith(expect.anything(), ORG, LEAD);
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(resultado(d.complete)).toEqual({ kind: "sent" });
  });

  it("o servidor recusa com fora_das_24h_do_instagram: pulo, não erro", async () => {
    runBeforeSend.mockResolvedValueOnce({ status: "sent", outcome: { kind: "failed", messageId: "msg-1" }, trace: [] });
    const { pool } = fakePool({ horas: 2, errorCode: "fora_das_24h_do_instagram" });
    const d = deps();
    await expect(criarHandler(d.deps)(job({ fixed_body: "oi" }), pool, ctx)).resolves.toBeUndefined();
    expect(resultado(d.complete)).toEqual({ kind: "pulado", reason: RAZAO });
  });

  it("outra falha do servidor continua sendo erro (retentado pela fila)", async () => {
    runBeforeSend.mockResolvedValueOnce({ status: "sent", outcome: { kind: "failed", messageId: "msg-1" }, trace: [] });
    const { pool } = fakePool({ horas: 2, errorCode: "outra_coisa" });
    const d = deps();
    await expect(criarHandler(d.deps)(job({ fixed_body: "oi" }), pool, ctx)).rejects.toThrow(/failed/);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("WhatsApp silenciado: o bloqueio de atendimento humano segue valendo (sem pulo, sem 24h)", async () => {
    isLeadInHandoff.mockResolvedValueOnce(true);
    const { pool } = fakePool({ horas: 30, provider: DEFAULT_CHANNEL_PROVIDER });
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: "oi" }), pool, ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: "skipped", reason: "O envio foi recusado pelas regras do atendimento." });
  });
});

describe("turno de fluxo — mensagem da IA (ai_message)", () => {
  it("dentro das 24h: o turno do agente roda", async () => {
    const { pool } = fakePool({ horas: 2 });
    const d = deps();
    await criarHandler(d.deps)(job({ prompt_hint: "retome" }), pool, ctx);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(resultado(d.complete)).toEqual({ kind: "sent" });
  });

  it("fora das 24h: pula antes de gastar o modelo", async () => {
    const { pool } = fakePool({ horas: 30 });
    const d = deps();
    await criarHandler(d.deps)(job({ prompt_hint: "retome" }), pool, ctx);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: "pulado", reason: RAZAO });
  });

  it("o envio do agente recusado com fora_das_24h_do_instagram: pulo", async () => {
    const { pool } = fakePool({ horas: 2, ledger: [{ status: "failed", error_code: "fora_das_24h_do_instagram" }] });
    const d = deps();
    await criarHandler(d.deps)(job({ prompt_hint: "retome" }), pool, ctx);
    expect(resultado(d.complete)).toEqual({ kind: "pulado", reason: RAZAO });
  });
});
