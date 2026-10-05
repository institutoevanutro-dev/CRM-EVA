/**
 * O CAMINHO LEGADO TAMBÉM REDIGE O ERRO DO PROVEDOR (revisão do PR 125).
 *
 * `llm_calls.error_message` é uma coluna só, lida por `GET /api/v1/ai/runs` e
 * mostrada em IA › Execuções a qualquer manager. Ela tem DOIS escritores: o
 * motor novo (`normalizarErro`, que passa por `redigirMensagemDoProvedor`) e
 * `logInvocation`, usado pelo classificador de sentimento e pelo worker de
 * resposta. O segundo gravava `JSON.stringify(error_payload)` cru — chave,
 * CPF e telefone que o provedor ecoasse chegavam à tela por ele.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

const { logInvocation } = await import("@/lib/ai/log-invocation");

/** `logInvocation` usa `queueMicrotask`; isto dá o tick para ele rodar. */
async function drenar(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const BASE = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  agent_id: null,
  conversation_id: null,
  message_id: null,
  invocation_kind: "sentiment_classify" as const,
  model: "anthropic/claude-haiku-4-5",
  prompt_tokens: 0,
  completion_tokens: 0,
  latency_ms: 42,
  cost_cents: 0,
};

describe("logInvocation redige o erro antes de gravar", () => {
  beforeEach(() => {
    inserts.length = 0;
  });

  it("a chave ecoada pelo provedor não chega à coluna que a tela lê", async () => {
    logInvocation({
      ...BASE,
      error_payload: { message: "401 unauthorized — Authorization: Bearer sk-or-v1-abcdefghijklmnop" },
    });
    await drenar();
    const gravado = String(inserts[0]!.error_message);
    expect(gravado).not.toContain("sk-or-v1-abcdefghijklmnop");
    expect(gravado).toContain("[CHAVE]");
  });

  it("CPF e telefone do paciente no texto de erro também não", async () => {
    // O erro de parse do SDK inclui o texto que o modelo devolveu.
    logInvocation({
      ...BASE,
      error_payload: { message: "could not parse: paciente 123.456.789-09, zap (27) 99999-1234" },
    });
    await drenar();
    const gravado = String(inserts[0]!.error_message);
    expect(gravado).not.toContain("123.456.789-09");
    expect(gravado).not.toContain("99999-1234");
  });

  it("o código do erro continua sendo classificado sobre o texto CRU", async () => {
    // Redigir antes de classificar poderia apagar a pista ("Insufficient
    // credits" não tem segredo, mas a ordem é o contrato).
    logInvocation({ ...BASE, error_payload: { message: "Insufficient credits" } });
    await drenar();
    expect(inserts[0]!.error_code).toBe("limite_ou_saldo");
    expect(String(inserts[0]!.error_message)).toContain("Insufficient credits");
  });
});
