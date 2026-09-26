/**
 * A marca `origemDoEnvio: "followup"` chega ao servidor de mensagens só quando o
 * envio é de follow-up.
 *
 * O servidor decide pela marca se o Instagram aceita o envio automático (dentro
 * das 24h). Ela não se deduz do ator: o agente de atendimento também é
 * `ai_agent`, e para ele o Instagram segue fechado. Então a borda do agente
 * repassa o que recebeu, e nada inventa a marca sozinha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageHandler = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ id: "msg-1", status: "sent" })));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler }));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  pgSendLedger: () => ({}),
  sendWithLedger: async (_s: unknown, _i: unknown, send: (k: string, m: string) => Promise<unknown>) => {
    await send("key-1", "msg-1");
    return { kind: "sent", idempotencyKey: "key-1", crmMessageId: "msg-1" };
  },
}));
// O follow-up confere a agenda antes de enviar; aqui só importa a marca.
vi.mock("@/lib/agenda/efeito", () => ({ assertAgendaEffectPg: async () => undefined }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({ requireCurrentServiceBoundary: async () => undefined }));

const { sendTurnMessage } = await import("@/lib/agent-engine/edge/crm/send-message");

let kindDoJob = "inbound_reply";
const db = { query: async () => ({ rows: [{ kind: kindDoJob, payload: {} }] }) } as never;
const cfg = { supabase: {} } as never;
const envio = { tenantId: "org-1", leadId: "lead-1", jobId: "job-1", seq: 1, conversationId: "conv-1", body: "oi" };
const ctxRecebido = () => sendMessageHandler.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  sendMessageHandler.mockClear();
  kindDoJob = "inbound_reply";
});

describe("sendTurnMessage repassa a origem do envio", () => {
  it("follow-up: o ctx do handler leva origemDoEnvio followup", async () => {
    await sendTurnMessage(db, cfg, { ...envio, origemDoEnvio: "followup" });
    expect(ctxRecebido().origemDoEnvio).toBe("followup");
  });

  it("atendimento (sem a marca): o ctx não leva origemDoEnvio", async () => {
    await sendTurnMessage(db, cfg, envio);
    expect(ctxRecebido().origemDoEnvio).toBeUndefined();
  });

  it("turno de follow-up com IA (ferramentas do agente, sem a marca): o job decide", async () => {
    kindDoJob = "followup_turn";
    await sendTurnMessage(db, cfg, envio);
    expect(ctxRecebido().origemDoEnvio).toBe("followup");
  });
});
