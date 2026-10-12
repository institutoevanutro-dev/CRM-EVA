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

import { esquecerAvisosDoProvedor } from "@/lib/agent-engine/edge/llm/aviso-do-provedor";
import { reiniciarDisjuntor } from "@/lib/ai/decisao/disjuntor";
import { logger } from "@/lib/logger";
import { observarComOJev, registrarClimaObservado } from "@/workers/ai-sentiment-worker.jev";

const ORG = "11111111-1111-4111-8111-111111111111";
const CTX = { organizationId: ORG, conversationId: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444", agentId: null };
const LIGADO = { jev: { ligado: true, aceite: { em: "2026-10-09T12:00:00.000Z", por: "u" } } };

let lidas: string[];
let escritas: Array<{ tabela: string; linha: Record<string, unknown> }>;
let reaberturas: Array<Record<string, unknown>>;
/** O Jev respondeu: fecha o aviso de crédito ou de chave DELE (`aviso-do-provedor.ts`). */
let fechamentos: Array<Record<string, unknown>>;
let settings: unknown;
/** A conversa lida logo antes do aviso. */
let conversa: Record<string, unknown> | null;
/** O erro que cada tabela devolve no insert (23505 = já existe). */
let erroNoInsert: Record<string, { code: string } | undefined>;
/** Probabilidade que o dublê do Jev devolve por pedido. */
let noul: Record<string, number>;

function admin() {
  return {
    from(tabela: string) {
      lidas.push(tabela);
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: tabela === "conversations" ? conversa : { settings }, error: null }),
        insert: async (linha: Record<string, unknown>) => {
          const error = erroNoInsert[tabela] ?? null;
          if (error === null) escritas.push({ tabela, linha });
          return { error };
        },
        // As únicas reescritas que o Jev pode fazer: reabrir o próprio aviso e,
        // quando volta a responder, fechar o aviso de crédito ou de chave dele.
        update: (patch: Record<string, unknown>) => {
          if (tabela !== "agent_inbox_items") throw new Error(`update em ${tabela}`);
          (patch.status === "resolved" ? fechamentos : reaberturas).push(patch);
          return { ...q, then: (ok: (v: { error: null }) => unknown) => ok({ error: null }) };
        },
        delete: () => {
          throw new Error(`delete em ${tabela}`);
        },
        upsert: () => {
          throw new Error(`upsert em ${tabela}`);
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
  reaberturas = [];
  fechamentos = [];
  esquecerAvisosDoProvedor();
  conversa = { status: "ai_handling", assigned_to_user_id: null, bot_silenced_until: null, contacts: { is_blocked: false } };
  erroNoInsert = {};
  noul = { opt_out: 0.85, humano: 0.1 };
  reiniciarDisjuntor();
  vi.mocked(logger.warn).mockClear();
  fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
    const pedidas = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    const answers: Record<string, unknown> = {};
    for (const id of pedidas) {
      answers[id] =
        id === "clima"
          ? { type: "score", score: 2, probabilities: {}, confidence: 0.9 }
          : { type: "noul", noul: noul[id] };
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

/**
 * "AVISAR A EQUIPE" (`decidindo`), só nos dois pedidos do cliente: a regra
 * disse não, o Jev disse sim acima do corte, e abre UM aviso na Central. Nada
 * além disso: `update`/`delete`/`upsert` em qualquer outra tabela lança no
 * dublê, e a única saída de rede é a pergunta ao Jev.
 */
describe("avisar a equipe", () => {
  const avisando = (tarefas: Record<string, { estado: string }>) => ({ jev: { ...LIGADO.jev, tarefas } });
  const NATURAL = "chega dessas mensagens toda semana";
  const avisos = () => escritas.filter((e) => e.tabela === "agent_inbox_items").map((e) => e.linha);

  beforeEach(() => {
    H.chave = "apikey_x";
    settings = avisando({ opt_out: { estado: "decidindo" }, humano: { estado: "decidindo" } });
  });

  it("regra disse não e o Jev disse sim acima do corte: UM aviso, sem o texto do cliente", async () => {
    await observarComOJev(admin(), { ...CTX, mensagem: NATURAL });
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]).toMatchObject({
      organization_id: ORG,
      kind: "jev_parar_de_receber",
      ref_kind: "conversation",
      ref_id: CTX.conversationId,
    });
    const texto = `${String(avisos()[0]!.title)} ${String(avisos()[0]!.body)}`;
    expect(texto).not.toContain(NATURAL);
    expect(texto).toMatch(/detector automático/);
    expect(texto).toMatch(/não bloqueia o contato/);
    expect(escritas.find((e) => e.linha.tarefa === "opt_out")!.linha).toMatchObject({ estado: "decidindo", rotulo_jev: "sim" });
  });

  it("nunca bloqueia, passa, cala nem responde: só observação, custo e aviso; uma saída de rede", async () => {
    noul = { opt_out: 0.99, humano: 0.99 };
    await observarComOJev(admin(), { ...CTX, mensagem: "alguém de verdade pode me tirar daí" });
    expect(new Set(escritas.map((e) => e.tabela))).toEqual(new Set(["llm_calls", "jev_observacoes", "agent_inbox_items"]));
    expect(avisos().map((a) => a.kind).sort()).toEqual(["jev_parar_de_receber", "jev_pedido_de_humano"]);
    expect(reaberturas).toEqual([]);
    // O Jev respondeu: a única outra escrita é fechar o aviso de crédito ou de chave dele.
    expect(fechamentos).toEqual([{ status: "resolved", resolved_at: expect.any(String) }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("api.typesafe.ai");
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it("abaixo do corte não avisa (0,79 no parar; 0,89 na pessoa)", async () => {
    noul = { opt_out: 0.79, humano: 0.89 };
    await observarComOJev(admin(), { ...CTX, mensagem: NATURAL });
    expect(avisos()).toEqual([]);
    expect(escritas.filter((e) => e.tabela === "jev_observacoes")).toHaveLength(2);
  });

  it("o Jev falhou: nada de aviso, e nada muda", async () => {
    fetchSpy.mockImplementation(async () => new Response("erro", { status: 500 }));
    await observarComOJev(admin(), { ...CTX, mensagem: NATURAL });
    expect(avisos()).toEqual([]);
  });

  it("a regra já pegou: o Jev nem é perguntado sobre aquele pedido, e não avisa", async () => {
    noul = { opt_out: 0.99, humano: 0.1 };
    await observarComOJev(admin(), { ...CTX, mensagem: "parar de me mandar mensagem" });
    const perguntas = Object.keys(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).questions);
    expect(perguntas).not.toContain("opt_out");
    expect(avisos()).toEqual([]);
  });

  it("tarefa em observando não avisa", async () => {
    settings = LIGADO;
    await observarComOJev(admin(), { ...CTX, mensagem: NATURAL });
    expect(avisos()).toEqual([]);
    expect(escritas.find((e) => e.linha.tarefa === "opt_out")!.linha).toMatchObject({ estado: "observando", rotulo_jev: "sim" });
  });

  it("o clima nunca avisa: decidindo gravado à mão o desliga, e a pergunta nem sai", async () => {
    settings = avisando({ clima: { estado: "decidindo" } });
    noul = { opt_out: 0.1, humano: 0.1 };
    expect(await observarComOJev(admin(), { ...CTX, mensagem: "que atendimento horrível" })).toBeNull();
    const perguntas = Object.keys(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).questions);
    expect(perguntas).not.toContain("clima");
    expect(avisos()).toEqual([]);
  });

  it("um aviso por conversa: o que já existe é reaberto, não duplicado", async () => {
    erroNoInsert = { agent_inbox_items: { code: "23505" } };
    await observarComOJev(admin(), { ...CTX, mensagem: NATURAL });
    expect(avisos()).toEqual([]);
    expect(reaberturas).toHaveLength(1);
    expect(reaberturas[0]).toMatchObject({ status: "open", resolved_at: null });
  });

  it("retry da mesma mensagem não reabre o que alguém resolveu", async () => {
    erroNoInsert = { jev_observacoes: { code: "23505" } };
    await observarComOJev(admin(), { ...CTX, mensagem: NATURAL });
    expect(avisos()).toEqual([]);
    expect(reaberturas).toEqual([]);
  });

  it("pedido que a conversa já atendeu não vira aviso", async () => {
    noul = { opt_out: 0.99, humano: 0.99 };
    conversa = { status: "ai_handling", assigned_to_user_id: "u", bot_silenced_until: null, contacts: { is_blocked: true } };
    await observarComOJev(admin(), { ...CTX, mensagem: "alguém de verdade pode me tirar daí" });
    expect(avisos()).toEqual([]);

    conversa = { status: "closed", assigned_to_user_id: null, bot_silenced_until: null, contacts: { is_blocked: false } };
    await observarComOJev(admin(), { ...CTX, messageId: "55555555-5555-4555-8555-555555555555", mensagem: "alguém de verdade pode me tirar daí" });
    expect(avisos()).toEqual([]);
  });
});
