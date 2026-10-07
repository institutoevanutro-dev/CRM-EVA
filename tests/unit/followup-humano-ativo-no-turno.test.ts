/**
 * Humano ativo no worker: o turno de fluxo (texto, modelo e IA) não envia e
 * ENCERRA a inscrição com `outcome: 'handoff'` quando uma pessoa da equipe
 * respondeu ou a conversa está atribuída a alguém. A decisão é a de
 * `conferirAntesDoEnvio` — a mesma do atalho do texto fixo.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as FollowupTurnModule from "@/lib/agent-engine/agent/followup-turn";
import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import { TEXTO_DO_BLOQUEIO } from "@/lib/followup/bloqueios-obrigatorios";

const runBeforeSend = vi.fn(async (_args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  status: "sent",
  outcome: { kind: "sent" },
  trace: [],
}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
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
const ENR = "11111111-1111-4111-8111-111111111111";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn", source_event_id: null,
    payload: { followup_enrollment_id: ENR, node_id: "node-1", purpose: "send_message", ...payload, service_boundary: boundary },
    status: "running", priority: 0, run_after: new Date(), attempts: 1, max_attempts: 3, last_error: null,
    locked_by: "w1", locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

function fakePool(conversa: { humano_respondeu?: boolean; atribuida_a_pessoa?: boolean }) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from send_ledger l/.test(sql)) return { rows: [{ status: "accepted", error_code: null }] };
    if (/from message_templates/.test(sql)) return { rows: [{ body: "Olá do modelo" }] };
    if (/from conversations/.test(sql)) {
      return { rows: [{
        id: CONVERSA, channel_session_id: "canal-1", archived_at: null, bot_silenciado: false,
        provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: new Date(),
        humano_respondeu: conversa.humano_respondeu ?? false, atribuida_a_pessoa: conversa.atribuida_a_pessoa ?? false,
      }] };
    }
    if (/from followup_enrollments e\b/.test(sql)) {
      return { rows: [{
        id: ENR, status: "active", started_at: new Date(0), pointer_id: "22222222-2222-4222-8222-222222222222",
        trigger_config: null, handoff_policy: "pause", appointment_id: null,
      }] };
    }
    if (/from contacts/.test(sql)) return { rows: [{ is_blocked: false, force_human: false, is_anonymized: false }] };
    if (/from organizations/.test(sql)) return { rows: [{ settings: {} }] };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

function deps() {
  const complete = vi.fn(async (..._a: unknown[]) => undefined);
  return {
    complete,
    deps: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {}, llmCfg: {}, knobs: {},
      channel: () => ({ send: vi.fn(async () => ({ kind: "sent" })) }),
      completeFollowupTurn: complete,
    } as never,
  };
}

const ctx = { workerId: "w1" };
let criarHandler: typeof FollowupTurnModule.createFollowupTurnHandler;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);
beforeEach(() => {
  runBeforeSend.mockClear();
  runAgentTurn.mockClear();
});

const resultado = (complete: ReturnType<typeof vi.fn>) => (complete.mock.calls[0]?.[1] as { result?: unknown } | undefined)?.result;
const ENCERRA = { kind: "skipped", reason: TEXTO_DO_BLOQUEIO.atendimento_humano, outcome: "handoff" };

describe("worker — humano ativo encerra o passo em todos os modos", () => {
  it("texto: uma pessoa respondeu → não chega à cadeia de envio; encerra com handoff", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: "oi" }), fakePool({ humano_respondeu: true }), ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual(ENCERRA);
  });

  it("modelo: conversa atribuída a uma pessoa → idem", async () => {
    const d = deps();
    await criarHandler(d.deps)(
      job({ template_id: "33333333-3333-4333-8333-333333333333" }),
      fakePool({ atribuida_a_pessoa: true }),
      ctx,
    );
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual(ENCERRA);
  });

  it("IA: uma pessoa respondeu → o turno do agente nem roda", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ prompt_hint: "retome" }), fakePool({ humano_respondeu: true }), ctx);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual(ENCERRA);
  });

  it("controle: tudo limpo → o texto chega à cadeia de envio", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: "oi" }), fakePool({}), ctx);
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(resultado(d.complete)).toEqual({ kind: "sent" });
  });
});
