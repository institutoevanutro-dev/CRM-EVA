import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A marca de origem chega a `messages.metadata` — e a `idempotency_key` do
 * ledger nunca é sobrescrita por ela. A chave é o que o replay pós-crash usa
 * para achar a mensagem já enviada; perdê-la é envio em dobro.
 */
const h = vi.hoisted(() => ({ handler: vi.fn() }));

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: h.handler }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  requireCurrentServiceBoundary: vi.fn(async () => undefined),
  currentExecutionBoundary: vi.fn(() => null),
  setExecutionAgentOperation: vi.fn(),
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  pgSendLedger: () => ({}),
  sendWithLedger: async (
    _store: unknown,
    _input: unknown,
    enviar: (key: string, messageId: string) => Promise<unknown>,
  ) => {
    await enviar("chave-1", "msg-1");
    return { kind: "sent", idempotencyKey: "chave-1", crmMessageId: "msg-1" };
  },
}));

import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";

const db = {
  query: vi.fn(async () => ({ rows: [{ kind: "inbound_turn", payload: {} }] })),
} as never;

function envia(metadata?: Record<string, string>) {
  return sendTurnMessage(db, { supabase: {} as never }, {
    tenantId: "org-1",
    leadId: "lead-1",
    jobId: "job-1",
    seq: -1,
    conversationId: "conv-1",
    body: "A limpeza custa R$ 180,00.",
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

function metadataGravada(): Record<string, unknown> {
  return (h.handler.mock.calls[0]![2] as { metadata: Record<string, unknown> }).metadata;
}

beforeEach(() => {
  h.handler.mockReset();
  h.handler.mockResolvedValue({ id: "msg-1", status: "sent" });
});

describe("sendTurnMessage — marca de origem", () => {
  it("leva a marca junto da idempotency_key", async () => {
    await envia({ resposta_pronta_id: "item-1" });
    expect(metadataGravada()).toEqual({ resposta_pronta_id: "item-1", idempotency_key: "chave-1" });
  });

  it("a marca NUNCA sobrescreve a idempotency_key do ledger", async () => {
    await envia({ idempotency_key: "forjada" });
    expect(metadataGravada()).toEqual({ idempotency_key: "chave-1" });
  });

  it("sem marca, a metadata é a de sempre", async () => {
    await envia();
    expect(metadataGravada()).toEqual({ idempotency_key: "chave-1" });
  });
});
