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
  CASO_DE_REPETICAO,
  decidirRepeticao,
  decidirSaidaDaRepeticao,
  ehConfirmacaoCurta,
  falaAntesDaEntrada,
  fraseDeRepeticaoJaSaiu,
  normalizarParaRepeticao,
  primeiroNomeDoContato,
  REPETICAO_PADRAO,
  repetiuNaConversa,
  terminaEmPerguntaReal,
  ultimaEntradaDoCliente,
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
    // A frase curta entra no lugar do corpo ANTES da cadeia: opt-out, anti-ban e janela valem para ela.
    expect(corpo.indexOf("body = saida.texto")).toBeGreaterThan(guarda);
    expect(corpo.indexOf("body = saida.texto")).toBeLessThan(corpo.indexOf("runBeforeSend("));
    // Na 2ª repetição, caso para a equipe com a fonte da guarda.
    expect(corpo).toMatch(/openCase\([\s\S]*CASO_DE_REPETICAO[\s\S]*source: 'guardrail_autofallback'/);
    // Depois que a guarda agiu, nenhum outro send_message do turno sai.
    expect(corpo.indexOf("if (repeticaoEncerrouOTurno)")).toBeLessThan(corpo.indexOf("formatarParaWhatsApp("));
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
    expect(REPETICAO_PADRAO).toEqual({
      janelaMs: 1_800_000,
      limiar: 0.8,
      limiarAposConfirmacao: 0.5,
      minTokens: 4,
      ultimas: 5,
      frases: ["Ficou alguma dúvida sobre isso?"],
    });
  });

  it("FALLBACK aceita variantes com |, vazio é o padrão e off desliga a frase", () => {
    const base = {
      SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "x",
    };
    const com = (v: string) =>
      turnKnobsFromEnv(loadEnv({ ...base, AI_REPEAT_GUARD_FALLBACK: v } as unknown as NodeJS.ProcessEnv)).repeticao?.frases;
    expect(com("Ficou alguma dúvida? | Posso te ajudar em mais algo?")).toEqual([
      "Ficou alguma dúvida?",
      "Posso te ajudar em mais algo?",
    ]);
    expect(com("")).toEqual(["Ficou alguma dúvida sobre isso?"]);
    expect(com("off")).toEqual([]);
  });
});

// ── no lugar da repetida: frase curta 1x, depois caso ─────────────────────

describe("o que sai no lugar da mensagem repetida", () => {
  const FRASES = ["Ficou alguma dúvida sobre isso?"];

  it("⭐ 1ª repetição na janela: sai a frase curta fixa", () => {
    expect(decidirSaidaDaRepeticao({ frases: FRASES, fraseJaSaiu: false, conversationId: "c1" })).toEqual({
      acao: "frase",
      texto: "Ficou alguma dúvida sobre isso?",
    });
  });

  it("⭐ repetiu de novo com a frase já enviada na janela: caso para a equipe, nenhuma frase", () => {
    expect(decidirSaidaDaRepeticao({ frases: FRASES, fraseJaSaiu: true, conversationId: "c1" })).toEqual({ acao: "caso" });
  });

  it("sem frase configurada, ou leitura falhou: só cala (comportamento anterior)", () => {
    expect(decidirSaidaDaRepeticao({ frases: [], fraseJaSaiu: false, conversationId: "c1" })).toEqual({ acao: "silencio" });
    expect(decidirSaidaDaRepeticao({ frases: [" "], fraseJaSaiu: true, conversationId: "c1" })).toEqual({ acao: "silencio" });
    expect(decidirSaidaDaRepeticao({ frases: FRASES, fraseJaSaiu: null, conversationId: "c1" })).toEqual({ acao: "silencio" });
  });

  it("com variantes, a escolha é estável por conversa", () => {
    const v = ["A dúvida?", "B dúvida?", "C dúvida?"];
    const um = decidirSaidaDaRepeticao({ frases: v, fraseJaSaiu: false, conversationId: "conv-x" });
    expect(decidirSaidaDaRepeticao({ frases: v, fraseJaSaiu: false, conversationId: "conv-x" })).toEqual(um);
    const vistas = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => {
        const s = decidirSaidaDaRepeticao({ frases: v, fraseJaSaiu: false, conversationId: id });
        return s.acao === "frase" ? s.texto : "";
      }),
    );
    expect(vistas.size).toBeGreaterThan(1);
  });

  it("o caso explica o laço sem prometer nada ao cliente", () => {
    expect(CASO_DE_REPETICAO.title.length).toBeGreaterThan(0);
    expect(CASO_DE_REPETICAO.summary).toContain("Nada repetido foi enviado");
  });
});

describe("fraseDeRepeticaoJaSaiu — lê só falas da IA na janela", () => {
  const log = { warn: vi.fn(), info: vi.fn() } as never;
  const agora = new Date("2026-10-21T12:00:00Z");

  it("acha a frase mesmo com caixa, pontuação e emoji diferentes", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ body: "Outra coisa" }, { body: "ficou alguma duvida sobre isso 😊" }] }) };
    expect(
      await fraseDeRepeticaoJaSaiu(pool, { organizationId: "o", conversationId: "c", agora, knobs: REPETICAO_PADRAO, log }),
    ).toBe(true);
    const [sql, params] = pool.query.mock.calls[0]!;
    expect(sql).toContain("m.sent_via = 'ai'");
    expect(params).toEqual(["o", "c", new Date(agora.getTime() - REPETICAO_PADRAO.janelaMs).toISOString()]);
  });

  it("frase ausente na janela: false", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ body: "Perfeito, combinado então" }] }) };
    expect(
      await fraseDeRepeticaoJaSaiu(pool, { organizationId: "o", conversationId: "c", agora, knobs: REPETICAO_PADRAO, log }),
    ).toBe(false);
  });

  it("falha de leitura: null (o turno só cala, nunca manda a frase às cegas)", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("boom")) };
    expect(
      await fraseDeRepeticaoJaSaiu(pool, { organizationId: "o", conversationId: "c", agora, knobs: REPETICAO_PADRAO, log }),
    ).toBeNull();
  });
});

// ── depois de "ok"/"sim": o modelo parafraseia, e o limiar aperta ─────────

describe("paráfrase depois de uma confirmação curta (limiar 0.5)", () => {
  const txt = (body: string) => ({ type: "text", body });
  const apos = (candidata: string, recentes: string[], body: string) =>
    decidirRepeticao({ candidata, recentes, primeiroNome: "Chris", knobs: K, ultimaEntrada: txt(body) });

  // Equivalentes fictícios dos dois padrões medidos em produção (23/10/2026).
  const RESERVA_1 = "Assim que o financeiro confirmar o comprovante, eu sigo com você para fechar a reserva, combinado?";
  const RESERVA_2 = "Assim que o financeiro confirmar, eu sigo por aqui com você pra fechar sua reserva, tá bom?";
  const EXAME_1 = "Vou confirmar a validade do pedido de exames com a equipe e te passo a informação correta";
  const EXAME_2 = "Vou checar com a equipe a validade do seu pedido de exames e te passo a informação correta, tá?";
  const EXAME_3 = "Já estou confirmando com a equipe a validade do pedido de exames e te passo a informação certinha";

  it("as paráfrases ficam abaixo de 0.8: sem a confirmação, a regra geral as deixa passar", () => {
    expect(decide(RESERVA_2, [RESERVA_1]).repetida).toBe(false);
    expect(decide(EXAME_2, [EXAME_1]).repetida).toBe(false);
  });

  it.each(["Ok", "sim", "Sim!", "ok obrigada", "No aguardo", "Por gentileza", "👍"])(
    "⭐ depois de %j a paráfrase é barrada",
    (body) => {
      expect(apos(RESERVA_2, [RESERVA_1], body).repetida).toBe(true);
      expect(apos(EXAME_2, [EXAME_1], body).repetida).toBe(true);
      expect(apos(EXAME_3, [EXAME_2, EXAME_1], body).repetida).toBe(true);
    },
  );

  it.each(["E qual o valor da reserva?", "ok, mas e se o financeiro não confirmar hoje", "Mandei o comprovante agora"])(
    "última entrada %j não é confirmação: vale o 0.8 e a paráfrase passa",
    (body) => {
      expect(apos(RESERVA_2, [RESERVA_1], body).repetida).toBe(false);
    },
  );

  it("resposta de fato diferente depois de um ok passa (Jaccard < 0.5)", () => {
    expect(apos("O financeiro confirmou: sua reserva está fechada para sexta às 14h.", [RESERVA_1], "ok").repetida).toBe(
      false,
    );
  });

  it("curta (menos de minTokens) passa mesmo depois de ok", () => {
    expect(apos("Combinado, Chris!", ["Combinado!"], "ok").repetida).toBe(false);
  });

  it("áudio, imagem e documento não contam como confirmação", () => {
    for (const type of ["audio", "image", "document"]) {
      expect(ehConfirmacaoCurta({ type, body: "ok" })).toBe(false);
    }
    expect(ehConfirmacaoCurta(null)).toBe(false);
  });

  it("o limiar apertado nunca afrouxa o geral", () => {
    const knobs = { ...K, limiarAposConfirmacao: 0.95 };
    const r = decidirRepeticao({ candidata: EXAME_1, recentes: [EXAME_1], primeiroNome: null, knobs, ultimaEntrada: txt("ok") });
    expect(r.repetida).toBe(true);
  });

  it("⭐ depois de uma resposta barrada pelo ok, a pergunta nova do cliente destrava a próxima resposta", () => {
    // Turno 1: cliente disse "ok"; a paráfrase é barrada.
    expect(apos(RESERVA_2, [RESERVA_1], "ok").repetida).toBe(true);
    // Turno 2: o cliente pergunta. A última entrada já não é confirmação: 0.8.
    const resposta = "Assim que o financeiro confirmar, eu sigo com você e te passo o valor da reserva, combinado?";
    expect(apos(resposta, [RESERVA_1], "e quanto fica a reserva?").repetida).toBe(false);
    // A mesma resposta, se o cliente só tivesse dito "ok", seria barrada.
    expect(apos(resposta, [RESERVA_1], "ok").repetida).toBe(true);
  });

  it("a última entrada sai do transcript do turno (a mais recente inbound; sem type = texto)", () => {
    expect(
      ultimaEntradaDoCliente([
        { direction: "inbound", body: "qual o valor?" },
        { direction: "outbound", body: RESERVA_1 },
        { direction: "inbound", body: "Ok" },
        { direction: "outbound", body: "x" },
      ]),
    ).toEqual({ type: "text", body: "Ok" });
    expect(ultimaEntradaDoCliente([{ direction: "inbound", body: "[audio]", type: "audio" }])).toEqual({
      type: "audio",
      body: "[audio]",
    });
    expect(ultimaEntradaDoCliente([])).toBeNull();
  });

  it("repetiuNaConversa repassa a última entrada à decisão", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ body: RESERVA_1 }] }) };
    const base = {
      organizationId: "o",
      conversationId: "c",
      candidata: RESERVA_2,
      nomeDoContato: "Chris",
      agora: new Date(),
      knobs: K,
      log: { warn: vi.fn() } as never,
    };
    expect((await repetiuNaConversa(pool, { ...base, ultimaEntrada: txt("ok") })).repetida).toBe(true);
    expect((await repetiuNaConversa(pool, { ...base, ultimaEntrada: txt("qual o valor?") })).repetida).toBe(false);
  });

  it("o knob vem do env, validado de 0 a 1", () => {
    const base = {
      SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "x",
    };
    const com = (v: string) =>
      turnKnobsFromEnv(
        loadEnv({ ...base, AI_REPEAT_GUARD_SIMILARITY_APOS_CONFIRMACAO: v } as unknown as NodeJS.ProcessEnv),
      ).repeticao?.limiarAposConfirmacao;
    expect(com("0.6")).toBe(0.6);
    expect(() => com("1.5")).toThrow();
  });

  it("a fiação passa a última entrada do transcript do turno", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    expect(src).toContain("ultimaEntrada: ultimaEntradaDoCliente(effectiveContext.messages)");
  });
});

// ── a fala confirmada era pergunta de verdade: o eco é a resposta certa ───

describe("pergunta de verdade → \"sim\" → resposta que ecoa a pergunta: passa", () => {
  const apos = (candidata: string, falaAnterior: string, body: string, recentes = [falaAnterior]) =>
    decidirRepeticao({
      candidata,
      recentes,
      primeiroNome: "Chris",
      knobs: K,
      ultimaEntrada: { type: "text", body },
      falaAnterior,
    });

  it("⭐ marcar avaliação: a confirmação do agendamento sai", () => {
    const pergunta = "Posso marcar sua avaliação para quinta às 10h na unidade 1?";
    const pronto = "Pronto, marquei sua avaliação para quinta às 10h na unidade 1!";
    expect(apos(pronto, pergunta, "sim").repetida).toBe(false);
    // Controle: se a fala confirmada fosse afirmação, o eco seria barrado.
    expect(apos(pronto, "Vou marcar sua avaliação para quinta.", "sim", [pergunta]).repetida).toBe(true);
  });

  it("⭐ \"Quer que eu te mande o link?\" → \"por favor\" → o link sai", () => {
    const pergunta = "Quer que eu te mande o link da sua consulta por aqui?";
    const link = "Pronto, te mandei o link da sua consulta por aqui: exemplo.test";
    expect(apos(link, pergunta, "por favor").repetida).toBe(false);
    // Controle: sem a pergunta antes, o eco (Jaccard 0.5) seria barrado.
    expect(apos(link, "Te mando o link da sua consulta por aqui.", "por favor", [pergunta]).repetida).toBe(true);
  });

  it("⭐ os padrões de hoje continuam barrados (muleta \"combinado?\" e afirmação)", () => {
    const r1 = "Assim que o financeiro confirmar o comprovante, eu sigo com você para fechar a reserva, combinado?";
    const r2 = "Assim que o financeiro confirmar, eu sigo por aqui com você pra fechar sua reserva, tá bom?";
    expect(apos(r2, r1, "Ok").repetida).toBe(true);
    const e1 = "Vou confirmar a validade do pedido de exames com a equipe e te passo a informação correta";
    const e2 = "Vou checar com a equipe a validade do seu pedido de exames e te passo a informação correta, tá?";
    expect(apos(e2, e1, "sim").repetida).toBe(true);
  });

  it("a fala confirmada é a nossa última ANTES das entradas do cliente", () => {
    expect(
      falaAntesDaEntrada([
        { direction: "outbound", body: "antiga" },
        { direction: "inbound", body: "oi" },
        { direction: "outbound", body: "Posso marcar quinta?" },
        { direction: "inbound", body: "sim" },
        { direction: "inbound", body: "obrigada" },
      ]),
    ).toBe("Posso marcar quinta?");
    expect(falaAntesDaEntrada([{ direction: "inbound", body: "sim" }])).toBeNull();
    expect(falaAntesDaEntrada([])).toBeNull();
  });

  it("a fiação passa a fala confirmada do transcript do turno", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    expect(src).toContain("falaAnterior: falaAntesDaEntrada(effectiveContext.messages)");
  });
});

describe("terminaEmPerguntaReal — pergunta-muleta não é pergunta", () => {
  it.each([
    "Assim que eu tiver a validação, te explico como seguimos, combinado?",
    "Te passo certinho por aqui, tudo bem?",
    "Já deixei com a equipe, ok?",
    "Te aviso amanhã, tá?",
    "Te aviso amanhã, ta?",
    "Fica para sexta, tá bom?",
    "Mando à tarde, certo?",
    "Remarco para segunda, pode ser?",
    "Seguimos assim, beleza?",
    "Então fica assim, fechado?",
    "A equipe te liga, né?",
    "Combinado, Chris?",
    "Te passo amanhã, combinado, Chris? 😊",
    "Te passo amanhã, Combinado ?🙏",
    "Vou confirmar com a equipe e te passo a informação correta",
    "Perfeito!",
    "",
  ])("%j: não", (t) => {
    expect(terminaEmPerguntaReal(t, "Chris")).toBe(false);
  });

  it.each([
    "Posso marcar sua avaliação para quinta às 10h na unidade 1?",
    "Quer que eu te mande o link?",
    "Tudo certo por aqui. Qual horário fica melhor para você?",
    "Combinado! Prefere manhã ou tarde? 😊",
    "Chris, você já fez esse exame antes?",
  ])("%j: sim", (t) => {
    expect(terminaEmPerguntaReal(t, "Chris")).toBe(true);
  });

  it("sem nome do contato, o nome no fim deixa a pergunta como real (lado seguro: não aperta)", () => {
    expect(terminaEmPerguntaReal("Combinado, Chris?", null)).toBe(true);
  });
});
