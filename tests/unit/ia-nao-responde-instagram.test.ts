/**
 * A IA nunca fala pelo Instagram — nem no caminho LEGADO
 * (`workers/ai-response-worker.ts`, pré-engine, para orgs sem versão de
 * agente publicada). `capabilitiesOf("meta_instagram").iaResponde` já é
 * `false`; este teste prova que o worker de fato PERGUNTA e para ANTES de
 * gastar token — não é o guard bonito no papel que ninguém chama.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-4-6",
  gatewayConfig: {},
  gatewayHeaders: () => ({}),
  isAiGatewayConfigured: () => true,
  isEmbeddingProviderConfigured: () => false,
}));

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";

function makeAdminStub(provider: string | null, queried: string[]) {
  const convRow = {
    id: CONV_ID,
    organization_id: ORG_ID,
    contact_id: CONTACT_ID,
    channel_session_id: "77777777-7777-4777-8777-777777777777",
    last_inbound_at: new Date().toISOString(),
    bot_silenced_until: null,
    last_handoff_at: null,
    assignee_kind: "ai",
    contacts: {
      id: CONTACT_ID,
      display_name: null,
      locale: "pt-BR",
      is_blocked: false,
      force_human: false,
      ai_authorized_at: new Date().toISOString(),
    },
    channel_sessions: provider ? { provider, metadata: {} } : { metadata: {} },
  };

  const from = (table: string) => {
    queried.push(table);
    const result =
      table === "conversations"
        ? convRow
        : table === "messages"
          ? { id: MSG_ID, body: "oi", direction: "inbound", organization_id: ORG_ID }
          : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
      then: (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: result ? [result] : [], error: null }).then(r),
    };
    return chain;
  };
  return { from } as never;
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

beforeEach(() => vi.clearAllMocks());

describe("ai-response-worker (legado) · Instagram não fala com a IA", () => {
  it("sessão meta_instagram → skip 'canal_sem_ia', ANTES de ler a mensagem", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub("meta_instagram", queried));
    const result = await processMessageReceived(eventRow);
    expect(result).toMatchObject({ status: "skipped", reason: "canal_sem_ia" });
    expect(queried).not.toContain("messages");
  });

  it("sessão waha → o guard não veta (avança no pipeline)", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub("waha", queried));
    const result = await processMessageReceived(eventRow);
    expect(result.reason).not.toBe("canal_sem_ia");
    expect(queried).toContain("messages");
  });

  it("provider ausente (banco antigo, coluna sem default alcançado) → o guard não veta", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(null, queried));
    const result = await processMessageReceived(eventRow);
    expect(result.reason).not.toBe("canal_sem_ia");
    expect(queried).toContain("messages");
  });
});
