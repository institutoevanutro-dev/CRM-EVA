// @vitest-environment node
/**
 * O AVISO DE CRÉDITO E DE CHAVE DO PROVEDOR DE IA.
 *
 * O caso de campo (11/10/2026, 18:51): a conta da OpenAI ficou sem crédito,
 * toda chamada voltou "You have no credits remaining" por umas 15 horas, e
 * ninguém foi avisado. Um dia antes, a chave do Jev foi recusada por horas, do
 * mesmo jeito calado.
 *
 * Este arquivo entra pelos TRÊS lugares em que o aviso é aberto e fechado em
 * produção (o seam do motor, o registro dos workers antigos e o registro do
 * Jev), com o banco dublado. O SQL contra o Postgres de verdade, com duas
 * organizações, está em `tests/invariants/espera-de-saldo.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const d = vi.hoisted(() => ({ admin: { valor: null as unknown } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => d.admin.valor }));

import {
  corpoDoAviso,
  ehAvisoDoProvedor,
  esquecerAvisosDoProvedor,
  FRASES_DO_AVISO_DO_PROVEDOR,
  motivoQueExigeODono,
  tituloDoAviso,
} from "@/lib/agent-engine/edge/llm/aviso-do-provedor";
import { LlmBudgetExceededError, normalizarErro, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { registrarChamada } from "@/lib/ai/decisao/registro";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { logInvocation } from "@/lib/ai/log-invocation";
import { somDoAviso } from "@/lib/notifications/sons-da-org";

const ORG = "33333333-3333-4333-8333-333333333333";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const CHAVE = "sk-CHAVE-QUE-NUNCA-PODE-VAZAR-9f3a2b";

const erro = (mensagem: string, statusCode?: number) =>
  Object.assign(new Error(mensagem), statusCode === undefined ? {} : { statusCode });

// As frases reais dos provedores.
const OPENAI_SEM_CREDITO = erro("You have no credits remaining", 429);
const OPENAI_SEM_COTA = erro("You exceeded your current quota, please check your plan and billing details.", 429);
const ANTHROPIC_SEM_CREDITO = erro(
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  400,
);
const CHAVE_INVALIDA = erro(`Incorrect API key provided: ${CHAVE}`, 401);
const LIMITE_DE_RITMO = erro("Rate limit reached for gpt-5.4 on tokens per min (TPM). Please try again in 2s.", 429);
const FORA_DO_AR = erro("The server had an error while processing your request", 503);
const TEMPO_ESGOTADO = erro("fetch failed: timeout");

const motivoDe = (e: unknown) => motivoQueExigeODono(e, normalizarErro(e));
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  esquecerAvisosDoProvedor();
});

describe("qual falha pede o dono", () => {
  it("sem crédito, na frase de cada provedor", () => {
    expect(motivoDe(OPENAI_SEM_CREDITO)).toBe("sem_saldo");
    expect(motivoDe(OPENAI_SEM_COTA)).toBe("sem_saldo");
    expect(motivoDe(ANTHROPIC_SEM_CREDITO)).toBe("sem_saldo");
    // O SDK embrulha o erro do provedor depois das tentativas dele.
    expect(motivoDe(new Error("Failed after 3 attempts", { cause: OPENAI_SEM_CREDITO }))).toBe("sem_saldo");
  });

  it("chave recusada", () => {
    expect(motivoDe(CHAVE_INVALIDA)).toBe("chave_recusada");
    expect(motivoDe(erro("authentication_error: invalid x-api-key", 401))).toBe("chave_recusada");
  });

  it("⭐ o MESMO 429: limite de ritmo não abre, sem crédito abre", () => {
    expect(normalizarErro(LIMITE_DE_RITMO).error_code).toBe("limite_ou_saldo");
    expect(normalizarErro(OPENAI_SEM_CREDITO).error_code).toBe("limite_ou_saldo");
    expect(motivoDe(LIMITE_DE_RITMO)).toBeNull();
    expect(motivoDe(OPENAI_SEM_CREDITO)).toBe("sem_saldo");
  });

  it("o que passa sozinho não abre: 5xx, tempo esgotado, e o 403 de um modelo só", () => {
    expect(motivoDe(FORA_DO_AR)).toBeNull();
    expect(motivoDe(TEMPO_ESGOTADO)).toBeNull();
    expect(motivoDe(erro("Project does not have access to model gpt-5.4", 403))).toBeNull();
    expect(motivoDe(erro("model not found", 404))).toBeNull();
    // O teto de gasto é recusa NOSSA e tem o aviso dele.
    expect(motivoDe(new LlmBudgetExceededError())).toBeNull();
  });
});

describe("o texto", () => {
  const quando = new Date("2026-10-11T21:51:00Z");

  it("diz o que houve, desde quando, o que parou, o que fazer e como fecha", () => {
    expect(tituloDoAviso("openai", "sem_saldo", "pt-BR")).toBe("A IA está sem crédito no provedor OpenAI (GPT)");
    expect(corpoDoAviso("openai", "sem_saldo", "pt-BR", "America/Sao_Paulo", quando)).toBe(
      "Desde 11/10 às 18:51, o provedor OpenAI (GPT) recusa as chamadas porque a conta ficou sem crédito. " +
        "Tudo o que usa este provedor está parado. Se é ele que responde aos clientes, o assistente não está respondendo. " +
        "O que fazer: coloque crédito na conta do provedor, no site dele. As respostas que ficaram na fila saem sozinhas quando o crédito voltar, por até 6 horas. " +
        "Este aviso se fecha sozinho quando o provedor voltar a aceitar uma chamada.",
    );
    expect(tituloDoAviso("anthropic", "chave_recusada", "pt-BR")).toBe(
      "O provedor Anthropic (Claude) recusou a chave da IA",
    );
    expect(corpoDoAviso("anthropic", "chave_recusada", "pt-BR", null, quando)).toContain("IA › Credenciais");
  });

  it("o do Jev diz que o assistente segue respondendo e onde fica a chave dele", () => {
    const corpo = corpoDoAviso("typesafe", "chave_recusada", "pt-BR", null, quando);
    expect(tituloDoAviso("typesafe", "chave_recusada", "pt-BR")).toBe("O provedor Jev (TypeSafe) recusou a chave da IA");
    expect(corpo).toContain("O assistente continua respondendo normalmente.");
    expect(corpo).toContain("JEV_API_KEY");
    expect(corpo).not.toContain("IA › Credenciais");
  });

  it("toda frase tem tradução, e nenhuma leva travessão", () => {
    for (const frase of FRASES_DO_AVISO_DO_PROVEDOR) {
      expect(DICIONARIO[frase]?.es, frase).toBeTruthy();
      expect(frase).not.toMatch(/[—–]/);
    }
  });

  it("a campainha e o celular reconhecem o aviso pelo título, em qualquer idioma e provedor", () => {
    for (const provedor of ["openai", "anthropic", "typesafe", "provedor-novo"]) {
      for (const motivo of ["sem_saldo", "chave_recusada"] as const) {
        for (const idioma of ["pt-BR", "es"] as const) {
          const titulo = tituloDoAviso(provedor, motivo, idioma);
          expect(ehAvisoDoProvedor(titulo), titulo).toBe(true);
          expect(somDoAviso({ kind: "other", ref_kind: null, title: titulo })).toBe("pessoa");
        }
      }
    }
    expect(ehAvisoDoProvedor("A IA está sem saldo no provedor")).toBe(false);
    expect(ehAvisoDoProvedor("As respostas automáticas da IA estão paradas")).toBe(false);
    expect(somDoAviso({ kind: "other", ref_kind: null, title: "Outro aviso qualquer" })).toBeNull();
    // Só o `other`: um kind com dono não vira pedido de pessoa por coincidência de título.
    expect(somDoAviso({ kind: "job_dead", ref_kind: null, title: tituloDoAviso("openai", "sem_saldo", "pt-BR") })).toBeNull();
  });

  it("fuso que o Intl não conhece não custa o aviso", () => {
    expect(corpoDoAviso("openai", "sem_saldo", "pt-BR", "Marte/Olympus", quando)).toContain("Desde 11/10 às 18:51");
  });
});

// ── O seam do motor ──────────────────────────────────────────────────────────

/** Pool de mentira: grava tudo o que toca `agent_inbox_items`. */
function poolDoSeam(opcoes: { provider?: string; avisoQuebra?: boolean } = {}) {
  const provider = opcoes.provider ?? "openai";
  const avisos: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [{ llm: { provider, default_model: "modelo-padrao", params: {}, enabled_models: [], monthly_budget_cents: null } }],
      };
    }
    if (sql.includes("agent_inbox_items")) {
      if (opcoes.avisoQuebra) throw new Error("a Central está fora do ar");
      avisos.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("select locale, timezone from organizations")) {
      return { rows: [{ locale: "pt-BR", timezone: "America/Sao_Paulo" }] };
    }
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return {
    pool: { query } as never,
    abertos: () => avisos.filter((a) => a.sql.includes("insert into agent_inbox_items")),
    fechados: () => avisos.filter((a) => a.sql.includes("update agent_inbox_items")),
  };
}

function registry(falha: unknown | null) {
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "x",
      modelId: "modelo-padrao",
      doGenerate: async () => {
        if (falha !== null) throw falha;
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    }) as never;
  return { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica };
}

const cfg = { anthropicApiKey: CHAVE, openaiApiKey: CHAVE, cacheTtl: "1h" as const };

/** Um turno de verdade pelo seam; devolve o que subiu para quem chamou. */
async function turno(pool: never, falha: unknown | null, org = ORG, purpose = "agent_turn") {
  let lancou: unknown = null;
  try {
    await runModelCall(
      pool,
      cfg,
      { tenantId: org, purpose, messages: [{ role: "user", content: "oi" }] },
      { registry: registry(falha) },
    );
  } catch (e) {
    lancou = e;
  }
  await tick();
  return lancou;
}

describe("o seam do motor abre e fecha o aviso", () => {
  it.each([
    ["openai", OPENAI_SEM_CREDITO, "A IA está sem crédito no provedor OpenAI (GPT)"],
    ["anthropic", ANTHROPIC_SEM_CREDITO, "A IA está sem crédito no provedor Anthropic (Claude)"],
    ["openai", CHAVE_INVALIDA, "O provedor OpenAI (GPT) recusou a chave da IA"],
    ["anthropic", erro("invalid x-api-key", 401), "O provedor Anthropic (Claude) recusou a chave da IA"],
  ])("%s: um turno recusado abre UM aviso crítico, e a rajada não abre outro", async (provider, falha, titulo) => {
    const banco = poolDoSeam({ provider });
    expect(await turno(banco.pool, falha)).toBe(falha);
    await turno(banco.pool, falha);
    await turno(banco.pool, falha, ORG, "stage_classifier");

    expect(banco.abertos()).toHaveLength(1);
    const { sql, params } = banco.abertos()[0]!;
    expect(sql).toMatch(/'other', 'critical'/);
    expect(sql).toMatch(/where not exists/);
    // organização (do job), título, corpo, e a chave da instalação: sem credencial.
    expect(params[0]).toBe(ORG);
    expect(params[1]).toBe(titulo);
    expect(params.slice(3)).toEqual([null, null]);
    // Nem a chave nem o texto do provedor chegam à Central.
    expect(JSON.stringify(params)).not.toContain(CHAVE);
    expect(JSON.stringify(params)).not.toMatch(/Incorrect API key|credit balance|no credits remaining/);
  });

  it("o botão Testar passa pelo mesmo seam", async () => {
    const banco = poolDoSeam();
    await turno(banco.pool, OPENAI_SEM_CREDITO, ORG, "connection_test");
    expect(banco.abertos()).toHaveLength(1);
  });

  it.each([
    ["limite de ritmo (429)", LIMITE_DE_RITMO],
    ["provedor fora do ar (503)", FORA_DO_AR],
    ["tempo esgotado", TEMPO_ESGOTADO],
  ])("%s NÃO abre aviso", async (_nome, falha) => {
    const banco = poolDoSeam();
    expect(await turno(banco.pool, falha)).toBe(falha);
    expect(banco.abertos()).toHaveLength(0);
  });

  it("a chamada aceita fecha os avisos daquele provedor, naquela organização", async () => {
    const banco = poolDoSeam();
    await turno(banco.pool, OPENAI_SEM_CREDITO);
    expect(await turno(banco.pool, null)).toBeNull();

    expect(banco.fechados()).toHaveLength(1);
    const { sql, params } = banco.fechados()[0]!;
    expect(sql).toMatch(/set status = 'resolved', resolved_at = now\(\)/);
    expect(params[0]).toBe(ORG);
    expect(params[1]).toEqual(expect.arrayContaining([
      "A IA está sem crédito no provedor OpenAI (GPT)",
      "O provedor OpenAI (GPT) recusou a chave da IA",
    ]));
    expect(params[2]).toBeNull();

    // Fechado, a falha seguinte é episódio novo: abre de novo.
    await turno(banco.pool, OPENAI_SEM_CREDITO);
    expect(banco.abertos()).toHaveLength(2);
  });

  it("sem falha antes, as chamadas aceitas conferem o banco uma vez só", async () => {
    const banco = poolDoSeam();
    await turno(banco.pool, null);
    await turno(banco.pool, null);
    await turno(banco.pool, null);
    expect(banco.fechados()).toHaveLength(1);
  });

  it("duas organizações: cada uma com o seu aviso, e o sucesso de uma não fecha o da outra", async () => {
    const banco = poolDoSeam();
    await turno(banco.pool, OPENAI_SEM_CREDITO, ORG);
    await turno(banco.pool, OPENAI_SEM_CREDITO, OUTRA_ORG);
    expect(banco.abertos().map((a) => a.params[0])).toEqual([ORG, OUTRA_ORG]);

    await turno(banco.pool, null, ORG);
    expect(banco.fechados().map((a) => a.params[0])).toEqual([ORG]);
  });

  it("a Central fora do ar não muda o desfecho do turno, nem na falha nem no sucesso", async () => {
    const banco = poolDoSeam({ avisoQuebra: true });
    // A falha que sobe é a do PROVEDOR, não a do aviso.
    expect(await turno(banco.pool, OPENAI_SEM_CREDITO)).toBe(OPENAI_SEM_CREDITO);
    expect(await turno(banco.pool, null)).toBeNull();
  });
});

// ── As duas pilhas do cliente admin ──────────────────────────────────────────

/** Cliente admin de mentira: grava cada operação em `agent_inbox_items`. */
function adminFalso() {
  const ops: Array<{ tabela: string; op: string; valores?: Record<string, unknown>; filtros: unknown[][] }> = [];
  const from = (tabela: string) => {
    const reg = { tabela, op: "select", filtros: [] as unknown[][], valores: undefined as Record<string, unknown> | undefined };
    const q: Record<string, unknown> = {};
    for (const f of ["eq", "is", "in", "limit"]) {
      q[f] = (...args: unknown[]) => {
        reg.filtros.push([f, ...args]);
        return q;
      };
    }
    q.select = () => q;
    q.insert = (valores: Record<string, unknown>) => {
      reg.op = "insert";
      reg.valores = valores;
      return q;
    };
    q.update = (valores: Record<string, unknown>) => {
      reg.op = "update";
      reg.valores = valores;
      return q;
    };
    q.maybeSingle = async () => ({ data: { locale: "pt-BR", timezone: "America/Sao_Paulo" }, error: null });
    q.then = (ok: (v: unknown) => unknown) => {
      ops.push(reg);
      return Promise.resolve({ data: [], error: null }).then(ok);
    };
    return q;
  };
  const daCentral = (op: string) => ops.filter((o) => o.tabela === "agent_inbox_items" && o.op === op);
  return { admin: { from }, abertos: () => daCentral("insert"), fechados: () => daCentral("update") };
}

describe("os workers antigos (clima e resposta) abrem e fecham pelo registro deles", () => {
  const linha = {
    organization_id: ORG,
    agent_id: null,
    conversation_id: null,
    message_id: null,
    invocation_kind: "sentiment_classify" as const,
    model: "anthropic/claude-haiku-4-5",
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ms: 10,
    cost_cents: 0,
  };

  it("clima na Anthropic sem crédito abre o aviso; limite de ritmo não; o sucesso fecha", async () => {
    const banco = adminFalso();
    d.admin.valor = banco.admin;

    logInvocation({ ...linha, error_payload: { message: "429 rate limit reached", status: 429 } });
    await tick();
    expect(banco.abertos()).toHaveLength(0);

    logInvocation({ ...linha, error_payload: { message: ANTHROPIC_SEM_CREDITO.message, status: 400 } });
    logInvocation({ ...linha, error_payload: { message: ANTHROPIC_SEM_CREDITO.message, status: 400 } });
    await tick();
    expect(banco.abertos()).toHaveLength(1);
    expect(banco.abertos()[0]!.valores).toMatchObject({
      organization_id: ORG,
      kind: "other",
      severity: "critical",
      title: "A IA está sem crédito no provedor Anthropic (Claude)",
      ref_id: null,
    });

    logInvocation(linha);
    await tick();
    expect(banco.fechados()).toHaveLength(1);
    expect(banco.fechados()[0]!.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(banco.fechados()[0]!.filtros).toContainEqual(["is", "ref_id", null]);
  });
});

describe("o Jev abre e fecha pelo registro dele", () => {
  const contexto = { organizationId: ORG, conversationId: null, messageId: "m1", agentId: null };
  const falha = (motivo: string, status: number) =>
    ({ ok: false, motivo, status, exigeAcao: true, defeitoNosso: false, latenciaMs: 5 }) as never;

  it("chave recusada (401) e conta sem crédito abrem, cada uma o seu; limite de taxa não; a resposta fecha", async () => {
    const banco = adminFalso();

    await registrarChamada(banco.admin as never, contexto, falha("limite_de_taxa", 429));
    await registrarChamada(banco.admin as never, contexto, falha("provedor_indisponivel", 503));
    expect(banco.abertos()).toHaveLength(0);

    await registrarChamada(banco.admin as never, contexto, falha("credencial_invalida", 401));
    await registrarChamada(banco.admin as never, contexto, falha("credencial_invalida", 401));
    await registrarChamada(banco.admin as never, contexto, falha("sem_credito", 402));
    expect(banco.abertos().map((a) => a.valores?.title)).toEqual([
      "O provedor Jev (TypeSafe) recusou a chave da IA",
      "A IA está sem crédito no provedor Jev (TypeSafe)",
    ]);
    expect(banco.abertos()[0]!.valores).toMatchObject({ organization_id: ORG, severity: "critical" });

    await registrarChamada(banco.admin as never, contexto, {
      ok: true,
      modelo: "jev-1.13.0",
      respostas: {},
      uso: { tokensDeEntrada: 1, tokensDeSaida: 0 },
      latenciaMs: 5,
    } as never);
    expect(banco.fechados()).toHaveLength(1);
  });
});
