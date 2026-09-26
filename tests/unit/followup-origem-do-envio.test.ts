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
vi.mock("@/lib/atendimento/fronteira-server", () => ({ requireCurrentServiceBoundary: async () => undefined }));

const { sendTurnMessage } = await import("@/lib/agent-engine/edge/crm/send-message");

const db = { query: async () => ({ rows: [{ kind: "inbound_reply", payload: {} }] }) } as never;
const cfg = { supabase: {} } as never;
const envio = { tenantId: "org-1", leadId: "lead-1", jobId: "job-1", seq: 1, conversationId: "conv-1", body: "oi" };
const ctxRecebido = () => sendMessageHandler.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => sendMessageHandler.mockClear());

describe("sendTurnMessage repassa a origem do envio", () => {
  it("follow-up: o ctx do handler leva origemDoEnvio followup", async () => {
    await sendTurnMessage(db, cfg, { ...envio, origemDoEnvio: "followup" });
    expect(ctxRecebido().origemDoEnvio).toBe("followup");
  });

  it("atendimento (sem a marca): o ctx não leva origemDoEnvio", async () => {
    await sendTurnMessage(db, cfg, envio);
    expect(ctxRecebido().origemDoEnvio).toBeUndefined();
  });
});
