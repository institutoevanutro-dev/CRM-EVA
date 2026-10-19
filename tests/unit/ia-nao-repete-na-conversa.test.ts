/**
 * A IA não responde a cada "ok" do paciente com a mesma frase.
 *
 * Produção, 19/10/2026: "OK", "No aguardo", "Verifique e me informe", "Por
 * gentileza" — e o agente respondeu cada um com quase a mesma mensagem, três
 * vezes em 2 minutos. A regra vive em
 * `lib/agent-engine/guardrails/repeticao-na-conversa.ts`; a fiação (só o texto
 * livre do `inbound_turn`, pulo com `ok: true`) em `inbound-turn.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  decidirRepeticao,
  normalizarParaRepeticao,
  primeiroNomeDoContato,
  REPETICAO_PADRAO,
  repetiuNaConversa,
} from "@/lib/agent-engine/guardrails/repeticao-na-conversa";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const K = REPETICAO_PADRAO;
const decide = (candidata: string, recentes: string[], primeiroNome: string | null = "Chris") =>
  decidirRepeticao({ candidata, recentes, primeiroNome, knobs: K });

const FINANCEIRO = "Assim que eu tiver a validação do financeiro, te explico certinho como seguimos, combinado?";
const EQUIPE = "Vou confirmar isso com a equipe pra te passar certinho";

describe("as sequências medidas em produção: a 1ª sai, as seguintes não", () => {
  it.each([
    ["financeiro, idêntica", FINANCEIRO, [FINANCEIRO, FINANCEIRO]],
    [
      "financeiro, com nome e pontuação trocados",
      FINANCEIRO,
      ["Chris, assim que eu tiver a validação do financeiro te explico certinho como seguimos. Combinado?", FINANCEIRO],
    ],
    ["equipe, idêntica", EQUIPE, [EQUIPE, EQUIPE]],
    ["equipe, com abertura", EQUIPE, ["Perfeito, Chris! Vou confirmar isso com a equipe pra te passar certinho.", EQUIPE]],
  ])("%s", (_caso, primeira, seguintes) => {
    const enviadas: string[] = [];
    // A 1ª sai: a conversa ainda não tem nada parecido.
    expect(decide(primeira, enviadas).repetida).toBe(false);
    enviadas.unshift(primeira);
    for (const s of seguintes) {
      expect(decide(s, enviadas).repetida).toBe(true);
    }
  });

  it("caixa, acento, pontuação e o primeiro nome não escondem a repetição", () => {
    expect(normalizarParaRepeticao("Perfeito, Chris. Já VALIDEI a ação!", "Chris")).toBe(
      normalizarParaRepeticao("perfeito ja validei a acao", null),
    );
  });
});

describe("o que deve passar", () => {
  it("conteúdo diferente passa", () => {
    expect(
      decide("O financeiro aprovou: a consulta fica R$ 450 e você pode pagar no Pix.", [FINANCEIRO, EQUIPE]).repetida,
    ).toBe(false);
  });

  it("mensagem curta (menos de 4 palavras) nunca é pulada", () => {
    expect(decide("Perfeito, Chris!", ["Perfeito!", "Perfeito, Chris."]).repetida).toBe(false);
    expect(decide("Combinado, até lá!", ["Combinado, até lá!"]).repetida).toBe(false);
  });

  it("só as últimas N falas entram na comparação", () => {
    const outras = Array.from({ length: K.ultimas }, (_, i) => `mensagem nova número ${i} sobre outro assunto`);
    expect(decide(EQUIPE, [...outras, EQUIPE]).repetida).toBe(false);
  });

  it("telefone não vira primeiro nome", () => {
    expect(primeiroNomeDoContato("5511999999999")).toBeNull();
    expect(primeiroNomeDoContato("  Chris Souza ")).toBe("Chris");
    expect(primeiroNomeDoContato(null)).toBeNull();
  });
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ORG = "13000000-0000-4000-8000-000000000001";
const CONVERSA = "13000000-0000-4000-8000-000000000002";
const OUTRA_CONVERSA = "13000000-0000-4000-8000-000000000003";
const AGORA = new Date("2026-10-19T14:00:00Z");

/** Banco de mentira que aplica os filtros que importam: org, conversa, janela, limite. */
function banco(linhas: { org: string; conversa: string; body: string; minutosAtras: number }[]) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    const [org, conversa, desde, limite] = params as [string, string, string, number];
    const rows = linhas
      .filter((l) => l.org === org && l.conversa === conversa)
      .filter((l) => AGORA.getTime() - l.minutosAtras * 60_000 >= new Date(desde).getTime())
      .sort((a, b) => a.minutosAtras - b.minutosAtras)
      .slice(0, limite)
      .map((l) => ({ body: l.body }));
    return { rows };
  });
  return { query };
}

const checar = (pool: ReturnType<typeof banco>, conversationId = CONVERSA, candidata = EQUIPE) =>
  repetiuNaConversa(pool as never, {
    organizationId: ORG,
    conversationId,
    candidata,
    nomeDoContato: "Chris",
    agora: AGORA,
    knobs: K,
    log: log as never,
  });

describe("repetiuNaConversa — a leitura do banco", () => {
  it("⭐ mesma conversa, dentro da janela → pula", async () => {
    const pool = banco([{ org: ORG, conversa: CONVERSA, body: EQUIPE, minutosAtras: 1 }]);
    expect((await checar(pool)).repetida).toBe(true);
    const [sql, params] = pool.query.mock.calls[0]!;
    expect(sql).toMatch(/m\.organization_id = \$1 and m\.conversation_id = \$2/);
    expect(sql).toMatch(/m\.sent_via = 'ai'/);
    expect(params[0]).toBe(ORG);
  });

  it("outra conversa → passa", async () => {
    const pool = banco([{ org: ORG, conversa: OUTRA_CONVERSA, body: EQUIPE, minutosAtras: 1 }]);
    expect((await checar(pool)).repetida).toBe(false);
  });

  it("outra organização, mesma conversa → passa", async () => {
    const pool = banco([{ org: "13000000-0000-4000-8000-0000000000ff", conversa: CONVERSA, body: EQUIPE, minutosAtras: 1 }]);
    expect((await checar(pool)).repetida).toBe(false);
  });

  it("fora da janela (31 min) → passa", async () => {
    const pool = banco([{ org: ORG, conversa: CONVERSA, body: EQUIPE, minutosAtras: 31 }]);
    expect((await checar(pool)).repetida).toBe(false);
  });

  it("leitura quebrada degrada ABERTO (envia)", async () => {
    const pool = { query: vi.fn(async () => { throw new Error("connection terminated"); }) };
    expect((await checar(pool as never)).repetida).toBe(false);
  });

  it("janela 0 desliga sem consultar o banco", async () => {
    const pool = banco([{ org: ORG, conversa: CONVERSA, body: EQUIPE, minutosAtras: 1 }]);
    const r = await repetiuNaConversa(pool as never, {
      organizationId: ORG, conversationId: CONVERSA, candidata: EQUIPE, nomeDoContato: null,
      agora: AGORA, knobs: { ...K, janelaMs: 0 }, log: log as never,
    });
    expect(r.repetida).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── a fiação: só o texto livre do inbound_turn, pulo silencioso ────────────

const raiz = path.resolve(__dirname, "../..");
const ler = (f: string) => fs.readFileSync(path.join(raiz, f), "utf8");
const INBOUND = ler("lib/agent-engine/agent/inbound-turn.ts");

function trecho(fonte: string, de: string, ate: string): string {
  const i = fonte.indexOf(de);
  expect(i, de).toBeGreaterThan(-1);
  const j = fonte.indexOf(ate, i);
  expect(j, ate).toBeGreaterThan(i);
  return fonte.slice(i, j);
}

describe("fiação — onde a guarda vale e onde não vale", () => {
  it("⭐ send_message consulta a guarda só no inbound_turn, ANTES da cadeia, e pula com ok:true", () => {
    const corpo = trecho(INBOUND, "send_message: tool({", "update_lead_state: tool({");
    const guarda = corpo.indexOf("repetiuNaConversa(");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(corpo.indexOf("runBeforeSend("));
    expect(corpo.slice(0, guarda)).toMatch(/if \(!preview && liveJob\(\)\.kind === 'inbound_turn'\) \{\s*const repeticao = await $/);
    expect(corpo).toMatch(/return \{ ok: true, status: 'nao_enviada_repetida', message: MENSAGEM_DE_REPETICAO \}/);
    // Conta como tentativa: o turno mudo não pede correção a quem decidiu calar.
    expect(corpo.indexOf("tentativasDeEnvio += 1")).toBeLessThan(guarda);
  });

  it("mídia e template não passam pela guarda", () => {
    expect(trecho(INBOUND, "send_media: tool({", "send_message: tool({")).not.toContain("repetiuNaConversa");
    expect(INBOUND.match(/repetiuNaConversa\(/g)).toHaveLength(1);
  });

  it.each([
    "lib/agent-engine/agent/followup-turn.ts",
    "lib/agent-engine/agent/aviso-de-escalacao.ts",
    "lib/agent-engine/agent/resposta-pronta.ts",
    "lib/agent-engine/guardrails/before-send.ts",
  ])("%s não usa a guarda (texto fixo e aviso de passagem saem sempre)", (f) => {
    expect(ler(f)).not.toContain("repeticao-na-conversa");
  });
});

describe("knobs", () => {
  it("defaults do env = os defaults do módulo, e chegam ao turno", () => {
    const env = loadEnv({
      SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "x",
    } as unknown as NodeJS.ProcessEnv);
    expect(turnKnobsFromEnv(env).repeticao).toEqual(REPETICAO_PADRAO);
    expect(REPETICAO_PADRAO).toEqual({ janelaMs: 1_800_000, limiar: 0.8, minTokens: 4, ultimas: 5 });
  });
});
