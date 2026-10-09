// @vitest-environment node
/**
 * O JEV NO WORKER DE CLIMA, SÓ OBSERVANDO (fase 1).
 *
 *  - sem chave: nem o banco é lido, nada sai;
 *  - com tudo ligado: uma chamada, texto limpo (sem CPF/telefone/e-mail),
 *    pedidos perguntados só onde a regra do fork disse não, e as únicas
 *    escritas são `jev_observacoes` e `llm_calls`;
 *  - o texto do cliente nunca vai para log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ chave: "" }));
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "JEV_API_KEY" ? H.chave : undefined) }),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reiniciarDisjuntor } from "@/lib/ai/decisao/disjuntor";
import { logger } from "@/lib/logger";
import { observarComOJev, registrarClimaObservado } from "@/workers/ai-sentiment-worker.jev";

const ORG = "11111111-1111-4111-8111-111111111111";
const CTX = { organizationId: ORG, conversationId: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444", agentId: null };
const LIGADO = { jev: { ligado: true, aceite: { em: "2026-10-09T12:00:00.000Z", por: "u" } } };

let lidas: string[];
let escritas: Array<{ tabela: string; linha: Record<string, unknown> }>;
let settings: unknown;

function admin() {
  return {
    from(tabela: string) {
      lidas.push(tabela);
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { settings }, error: null }),
        insert: async (linha: Record<string, unknown>) => {
          escritas.push({ tabela, linha });
          return { error: null };
        },
        update: () => {
          throw new Error(`update em ${tabela}`);
        },
      };
      return q;
    },
  } as never;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  H.chave = "";
  settings = LIGADO;
  lidas = [];
  escritas = [];
  reiniciarDisjuntor();
  vi.mocked(logger.warn).mockClear();
  fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
    const pedidas = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    const answers: Record<string, unknown> = {};
    for (const id of pedidas) {
      answers[id] =
        id === "clima"
          ? { type: "score", score: 2, probabilities: {}, confidence: 0.9 }
          : { type: "noul", noul: id === "opt_out" ? 0.85 : 0.1 };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 500 } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

describe("sem chave", () => {
  it("não lê o banco nem sai para a rede", async () => {
    expect(await observarComOJev(admin(), { ...CTX, mensagem: "parem de mandar" })).toBeNull();
    expect(lidas).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("com chave e o Jev ligado", () => {
  beforeEach(() => {
    H.chave = "apikey_x";
  });

  it("organização que não ligou: lê a config e não sai nada", async () => {
    settings = {};
    expect(await observarComOJev(admin(), { ...CTX, mensagem: "oi" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("o texto sai limpo, numa chamada só", async () => {
    await observarComOJev(admin(), { ...CTX, mensagem: "meu cpf é 123.456.789-09, zap (11) 98765-4321, a@b.com" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const corpo = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(corpo).not.toContain("123.456.789-09");
    expect(corpo).not.toContain("98765-4321");
    expect(corpo).not.toContain("a@b.com");
  });

  it("pedido que a regra do fork já pegou não é perguntado ao Jev", async () => {
    await observarComOJev(admin(), { ...CTX, mensagem: "quero falar com uma pessoa" });
    const perguntas = Object.keys(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).questions);
    expect(perguntas.sort()).toEqual(["clima", "opt_out"]);
  });

  it("só escreve observação e custo; o Jev percebe o que a regra deixou passar", async () => {
    const clima = await observarComOJev(admin(), { ...CTX, mensagem: "chega dessas mensagens toda semana" });
    expect(new Set(escritas.map((e) => e.tabela))).toEqual(new Set(["llm_calls", "jev_observacoes"]));
    const optOut = escritas.find((e) => e.linha.tarefa === "opt_out")!.linha;
    expect(optOut).toMatchObject({ estado: "observando", rotulo_jev: "sim", rotulo_atual: "nao" });
    expect(clima).toMatchObject({ nota: 0.5 });
  });

  it("o clima vira par com a IA de sempre, pelo mesmo limiar", async () => {
    await registrarClimaObservado(admin(), CTX, { nota: 0.5, confianca: 0.9, modelo: "jev-1.13.0", latenciaMs: 300 }, 0.1, 0.3);
    expect(escritas[0]!.linha).toMatchObject({ tarefa: "clima", rotulo_jev: "ok", rotulo_atual: "reclamando" });
  });

  it("a mensagem nunca vai para log, nem quando falha", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("rede caiu: segredo-do-cliente");
    });
    await observarComOJev(admin(), { ...CTX, mensagem: "segredo-do-cliente" });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("segredo-do-cliente");
  });
});
