/**
 * Passo de mídia do follow-up (biblioteca de mídias, fatia 4): o worker envia o
 * item da biblioteca pela MESMA cadeia de guardrails do texto fixo, sem LLM.
 *
 * - legenda passa por {{nome}}/{{primeiro_nome}} como o texto fixo;
 * - legenda vazia desarma o spinning (toda mídia sem legenda colidiria no corpo vazio);
 * - a recusa da mídia (422 media_not_found/media_not_ready) vira passo PULADO,
 *   marcado para o aviso na Central — nunca sobe (o job repetiria uma recusa que não muda);
 * - `queued` (canal fora) segue lançando, como o texto fixo: o job tenta de novo.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as FollowupTurnModule from "@/lib/agent-engine/agent/followup-turn";
import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type * as SendMessageModule from "@/lib/agent-engine/edge/crm/send-message";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

// A cadeia é simulada, mas CHAMA o `send` de verdade: é ele que leva a mídia ao canal.
const runBeforeSend = vi.fn(async (args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  status: "sent",
  outcome: await (args.send as (b: string) => Promise<unknown>)(args.body as string),
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
vi.mock("@/lib/agent-engine/edge/crm/send-message", async (original) => ({
  ...(await original<typeof SendMessageModule>()),
  applySendOutcome: vi.fn(async () => undefined),
}));

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const ENR = "11111111-1111-4111-8111-111111111111";
const MIDIA = "33333333-3333-4333-8333-333333333333";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn", source_event_id: null,
    payload: { followup_enrollment_id: ENR, node_id: "node-1", purpose: "send_message", ...payload, service_boundary: boundary },
    status: "running", priority: 0, run_after: new Date(), attempts: 1, max_attempts: 3, last_error: null,
    locked_by: "w1", locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

/** Pool que responde como o Postgres para uma conversa de WhatsApp em atendimento pelo bot. */
function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from send_ledger l/.test(sql)) return { rows: [{ status: "accepted", error_code: null }] };
    if (sql.includes("select current_node_id, status from followup_enrollments")) return { rows: [{ current_node_id: "node-1", status: "active" }], rowCount: 1 };
    if (/from conversations/.test(sql)) {
      return { rows: [{
        id: CONVERSA, channel_session_id: "canal-1", archived_at: null, bot_silenciado: false,
        provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: new Date(Date.now() - 3_600_000),
      }] };
    }
    if (/from followup_enrollments e\b/.test(sql)) {
      return { rows: [{
        id: ENR, status: "active", started_at: new Date(0), pointer_id: "22222222-2222-4222-8222-222222222222",
        trigger_config: null, appointment_id: null, reserva_criada_em: null, reserva_consulta_em: null, reserva_sujeita_a_sinal: null,
      }] };
    }
    if (/from contacts/.test(sql)) {
      return { rows: [{ name: "Maria Souza", display_name: "Maria Souza", is_blocked: false, force_human: false, is_anonymized: false }] };
    }
    if (/from organizations/.test(sql)) return { rows: [{ settings: {} }] };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

function deps(send: (...a: unknown[]) => Promise<unknown> = async () => ({ kind: "sent" })) {
  const complete = vi.fn(async (..._a: unknown[]) => undefined);
  const sendFn = vi.fn(send);
  return {
    complete,
    send: sendFn,
    deps: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {}, llmCfg: {}, knobs: {},
      channel: () => ({ send: sendFn }),
      completeFollowupTurn: complete,
    } as never,
  };
}

const ctx = { workerId: "w1" };
let criarHandler: typeof FollowupTurnModule.createFollowupTurnHandler;
let MidiaRecusadaError: typeof SendMessageModule.MidiaRecusadaError;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
  ({ MidiaRecusadaError } = await import("@/lib/agent-engine/edge/crm/send-message"));
}, 60_000);
beforeEach(() => {
  runBeforeSend.mockClear();
  runAgentTurn.mockClear();
});

const resultado = (complete: ReturnType<typeof vi.fn>) => (complete.mock.calls[0]?.[1] as { result?: unknown } | undefined)?.result;
const argsDaCadeia = () => runBeforeSend.mock.calls[0]?.[0] as Record<string, unknown>;

describe("turno de fluxo — passo de mídia", () => {
  it("mídia pronta: envia o item com a legenda interpolada, conclui 'sent' e nunca chama a IA", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ media_id: MIDIA, media_caption: "Oi {{primeiro_nome}}, veja" }), fakePool(), ctx);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0]![0]).toMatchObject({ body: "Oi Maria, veja", mediaLibraryItemId: MIDIA, origemDoEnvio: "followup" });
    expect(argsDaCadeia().enforceSpinning).toBeUndefined();
    expect(resultado(d.complete)).toEqual({ kind: "sent" });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("sem legenda: desarma o spinning e envia a mídia com corpo vazio", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ media_id: MIDIA }), fakePool(), ctx);
    expect(argsDaCadeia().enforceSpinning).toBe(false);
    expect(d.send.mock.calls[0]![0]).toMatchObject({ body: "", mediaLibraryItemId: MIDIA });
    expect(resultado(d.complete)).toEqual({ kind: "sent" });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("mídia recusada (revogada/sem arquivo): a sequência é encerrada (skipped) com o motivo e marcada para o aviso na Central", async () => {
    const motivo = "Esta mídia não pode ser enviada agora: consentimento revogado.";
    const d = deps(async () => {
      throw new MidiaRecusadaError("media_not_ready", motivo, "req-1", "consentimento_revogado");
    });
    await expect(criarHandler(d.deps)(job({ media_id: MIDIA }), fakePool(), ctx)).resolves.toBeUndefined();
    expect(resultado(d.complete)).toEqual({ kind: "skipped", reason: motivo, midiaRecusada: true });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("canal fora (queued): lança para o job tentar de novo, sem concluir o passo", async () => {
    const d = deps(async () => ({ kind: "queued", messageId: "msg-1" }));
    await expect(criarHandler(d.deps)(job({ media_id: MIDIA }), fakePool(), ctx)).rejects.toThrow(/aguardando o canal/);
    expect(d.complete).not.toHaveBeenCalled();
  });
});
