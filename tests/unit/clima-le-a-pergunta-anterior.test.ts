/**
 * O CLIMA LÊ A PERGUNTA QUE A MENSAGEM RESPONDE.
 *
 * Medido em produção (09/10/2026): a Cintia perguntou "Hoje você já faz algum
 * acompanhamento com médico, nutricionista ou personal, ou ainda não?", o
 * paciente respondeu "Não", e o classificador — que recebia só a palavra —
 * deu nota 0,15, a faixa de xingamento. A conversa foi para humano por
 * `low_sentiment` com o cliente no meio da qualificação. Na mesma quinzena,
 * "Negativo", "esquenta nao" e "Irado, mano" levaram a mesma nota.
 *
 * O modelo não é testável aqui; o que se prende é o que ele RECEBE: a última
 * mensagem do atendimento ao lado da resposta, e uma régua que diz que
 * resposta curta a pergunta é neutra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({
  resolverModeloDoPonto: vi.fn(async () => ({ model: "modelo", modelId: "modelo" })),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({ permite: true })),
}));
vi.mock("@/lib/ai/agents/no-ar", () => ({
  agenteAtende: () => true,
  precisaRecuperarLegado: () => false,
}));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";

import { createAdminClient } from "@/lib/supabase/admin";
import { promptDoClima, SENTIMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts/sentiment";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processSentiment } from "@/workers/ai-sentiment-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const PERGUNTA =
  "Hoje você já faz algum acompanhamento com médico, nutricionista ou personal, ou ainda não?";

const recebida = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: ORG,
  conversation_id: CONV,
  direction: "inbound",
  body: "Não",
  metadata: {},
  created_at: "2026-10-09T21:37:36Z",
};

/** Responde a leitura da mensagem recebida e a da última enviada. */
function admin(ultimaEnviada: string | null) {
  const from = (tabela: string) => {
    const eqs: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_a, prop: string) => {
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              if (tabela === "messages" && eqs.direction === "outbound") {
                return { data: ultimaEnviada === null ? null : { body: ultimaEnviada }, error: null };
              }
              if (tabela === "messages") return { data: recebida, error: null };
              if (tabela === "conversations") return { data: { id: CONV, channel_session_id: null }, error: null };
              return { data: null, error: null };
            };
          }
          if (prop === "then") {
            const data = tabela === "ai_agents" ? [{ id: "ag", config: {} }] : [];
            return (ok: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok);
          }
          return (...args: unknown[]) => {
            if (prop === "eq") eqs[args[0] as string] = args[1];
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const evento = {
  id: "e1",
  organization_id: ORG,
  entity_id: recebida.id,
  payload: { message_id: recebida.id, conversation_id: CONV },
} as unknown as EventRow;

describe("o classificador recebe a pergunta junto da resposta", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
    vi.mocked(generateObject).mockResolvedValue({
      object: { sentiment_score: 0.5, reasoning_short: "neutro" },
      usage: {},
    } as never);
  });

  it("'Não' chega ao modelo com a pergunta da Cintia ao lado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin(PERGUNTA) as never);
    await processSentiment(evento);
    const prompt = vi.mocked(generateObject).mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain(PERGUNTA);
    expect(prompt).toContain("Não");
  });

  it("sem mensagem anterior, classifica só a resposta, como antes", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin(null) as never);
    await processSentiment(evento);
    expect(vi.mocked(generateObject).mock.calls[0]?.[0]?.prompt).toBe("Não");
  });
});

describe("a régua", () => {
  it("diz que resposta curta a pergunta é neutra e que gíria não é hostilidade", () => {
    expect(SENTIMENT_SYSTEM_PROMPT).toMatch(/Resposta curta a uma pergunta \("Não"/);
    expect(SENTIMENT_SYSTEM_PROMPT).toMatch(/entre 0\.4 e 0\.6/);
    expect(SENTIMENT_SYSTEM_PROMPT).toMatch(/Gíria, palavrão ou exagero/);
  });

  it("o prompt corta a mensagem anterior longa", () => {
    expect(promptDoClima("Não", "x".repeat(2000)).length).toBeLessThan(700);
  });
});
