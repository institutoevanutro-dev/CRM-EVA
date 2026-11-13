import fs from "node:fs";
import path from "node:path";

import type { FinishReason } from "ai";
import { describe, expect, it } from "vitest";

import {
  INSTRUCAO_DO_PEDIDO_HUMANO,
  previaContinuaAtePropor,
  tetoDePassosAtingido,
  type SinaisDoPedidoHumano,
} from "./proposta-sob-pedido";

/**
 * A régua do pedido humano (porte do #3557, issue #3281 do original), caso a caso,
 * e as guardas estruturais do passo no motor deste fork. O caminho inteiro, com
 * banco e dublê de modelo, está em
 * `tests/invariants/previa-assistida-propoe-sob-pedido.test.ts`.
 */
const sinais = (over: Partial<SinaisDoPedidoHumano> = {}) =>
  previaContinuaAtePropor({
    candidatos: 0,
    propostas: 0,
    impedimentos: [],
    tentativasDeEnvio: 0,
    textoEscrito: "",
    inboundsSemResposta: 2,
    finishReason: "stop",
    saidaTruncada: false,
    tetoDePassosAtingido: false,
    ...over,
  });

describe("pedido humano: uma recuperação só para silêncio inicial sem oferta nem veto", () => {
  it("o silêncio inicial do caso3281 permite pedir o texto", () => {
    expect(sinais()).toBe(true);
    expect(sinais({ textoEscrito: " \n " })).toBe(true);
  });

  it.each([
    "contato_bloqueado",
    "messaging_window_closed",
    "outside_window",
    "warmup_cap",
    "daily_cap",
    "commercial_requires_human",
    "promise_out_of_table",
    "promise_semantic",
    "case_promise_without_case",
    "clinical_claim",
    "internal_vocabulary_leak",
    "lgpd_anonymized",
    "lgpd_missing_legal_basis",
    "contato_interno",
    "disclosure_required",
    "agenda_stall_sem_ferramenta",
    "midia_sem_fotos",
    // Os vetos de agenda deste fork (#3596): o ensino já voltou ao modelo.
    "horario_sem_fonte",
    "agenda_confirmou_sem_marcar",
    "gate_novo_ainda_nao_classificado",
  ])("não paga nova geração depois do impedimento %s", (codigo) => {
    expect(sinais({ impedimentos: [codigo] })).toBe(false);
  });

  it("candidato aceito já é uma oferta, sem chamada extra", () => {
    expect(sinais({ candidatos: 1 })).toBe(false);
  });

  it("proposta voltada ao cliente já é oferta", () => {
    // A função pura conta o que receber; quem decide o que é "voltada ao cliente"
    // (send_template, send_media) é o call site — ver a guarda estrutural abaixo.
    expect(sinais({ propostas: 1 })).toBe(false);
  });

  it("uma tentativa de envio não é silêncio inicial", () => {
    expect(sinais({ tentativasDeEnvio: 1 })).toBe(false);
  });

  it("texto solto não recebe o pedido humano", () => {
    // Sem o #3093 do original este fork não corrige texto solto na prévia: o
    // rascunho continua sem candidato, e o pedido humano não ocupa essa vaga.
    expect(sinais({ textoEscrito: "Bom dia! Posso ajudar com o seu pedido?" })).toBe(false);
  });

  it("não inventa assunto quando não há inbound sem resposta", () => {
    expect(sinais({ inboundsSemResposta: 0 })).toBe(false);
  });

  it("truncamento e teto de passos continuam falha de geração", () => {
    expect(sinais({ saidaTruncada: true })).toBe(false);
    expect(sinais({ tetoDePassosAtingido: true })).toBe(false);
  });

  it.each<FinishReason | undefined>([
    "content-filter", "error", "other", "length", "tool-calls", undefined,
  ])("não confunde término %s com silêncio normal confirmado", (finishReason) => {
    expect(sinais({ finishReason })).toBe(false);
  });
});

describe("teto de passos: parou no limite ainda chamando ferramenta", () => {
  it("⭐ todos os passos gastos e o último ainda pedia ferramenta: é falha", () => {
    expect(tetoDePassosAtingido({ passosUsados: 8, maxSteps: 8, finishReason: "tool-calls" })).toBe(true);
    expect(tetoDePassosAtingido({ passosUsados: 9, maxSteps: 8, finishReason: "tool-calls" })).toBe(true);
  });

  it("abaixo do teto, o modelo parou por conta própria", () => {
    expect(tetoDePassosAtingido({ passosUsados: 7, maxSteps: 8, finishReason: "tool-calls" })).toBe(false);
  });

  it.each<FinishReason | undefined>(["stop", "length", "content-filter", "error", "other", undefined])(
    "no teto, mas terminado em %s, não é o teto que parou",
    (finishReason) => {
      expect(tetoDePassosAtingido({ passosUsados: 8, maxSteps: 8, finishReason })).toBe(false);
    },
  );

  it("teto zero não é teto", () => {
    expect(tetoDePassosAtingido({ passosUsados: 0, maxSteps: 0, finishReason: "tool-calls" })).toBe(false);
  });
});

describe("a instrução pede somente a mensagem destinada ao cliente", () => {
  it("identifica o clique e conserva as regras de conteúdo e a aprovação", () => {
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toContain("Sugerir resposta");
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toContain("pediu um texto para esta conversa");
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toMatch(/regras de conteúdo/);
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toMatch(/cadeia de envio/);
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toMatch(/aprovação/);
  });

  it("não pede justificativa privada no corpo que poderá ser aprovado", () => {
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).not.toMatch(/diga|explique|motivo|para quem vai revisar/i);
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toContain("somente a mensagem destinada ao cliente");
  });
});

describe("o passo no motor deste fork (guardas estruturais)", () => {
  const ler = (arquivo: string) => fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");
  const turno = ler("lib/agent-engine/agent/inbound-turn.ts");
  const inicio = turno.indexOf("const pedidoHumano =");
  // O bloco da correção, do `if` que a pede até a chamada de modelo dela.
  const ifDaCorrecao = turno.indexOf("if (", inicio);
  const chamada = turno.indexOf("await runModelCall(", ifDaCorrecao);
  const fimDaChamada = turno.indexOf("{ registry: deps.registry, log: runLog },", chamada);
  const regua = turno.slice(inicio, ifDaCorrecao);
  const condicao = turno.slice(ifDaCorrecao, turno.indexOf("{", ifDaCorrecao + 4));
  const correcao = turno.slice(ifDaCorrecao, fimDaChamada);

  it("controle: as âncoras existem, em ordem", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(ifDaCorrecao).toBeGreaterThan(inicio);
    expect(chamada).toBeGreaterThan(ifDaCorrecao);
    expect(fimDaChamada).toBeGreaterThan(chamada);
  });

  it("⭐ o passo mora no bloco da correção do turno mudo: a mesma vaga, nunca uma chamada própria", () => {
    expect(condicao).toContain("pedidoHumano ||");
    expect(condicao).toContain("turnoMudoPedeCorrecao(silencioDoTurno())");
    expect(correcao).toMatch(
      /content: pedidoHumano\s*\?\s*INSTRUCAO_DO_PEDIDO_HUMANO\s*:\s*correcaoDoTurnoMudo\(/,
    );
    expect(correcao).toContain("Math.min(maxSteps, PASSOS_DA_CORRECAO)");
    expect(correcao).toContain("purpose: preview ? 'agent_preview' : 'agent_turn'");
  });

  it("só o rascunho do clique liga a régua, e só proposta que o cliente veria é oferta", () => {
    expect(regua).toContain("preview?.kind === 'assisted'");
    expect(regua).toContain("preview.pedidoHumano === true");
    expect(regua).toContain("p.tool === 'send_template' || p.tool === 'send_media'");
    // O worker escreve rascunho sozinho em dois pontos deste arquivo; nenhum diz
    // que uma pessoa pediu. Quem liga é a rota do clique.
    expect(turno).not.toMatch(/pedidoHumano:\s*true/);
    expect(ler("app/api/v1/conversations/[id]/draft-reply/route.ts")).toMatch(/pedidoHumano:\s*true/);
  });

  it("a instrução aparece uma vez no motor, sem cópia do texto", () => {
    const usos = turno.split("INSTRUCAO_DO_PEDIDO_HUMANO").length - 1;
    // o import + o único uso, no conteúdo do pedido.
    expect(usos).toBe(2);
    expect(turno).not.toContain("pediu um texto para esta conversa");
  });

  it("o passo usa as ferramentas da prévia: o envio é o de applyPreviewPolicy", () => {
    expect(turno).toMatch(/const tools = emOrdemDeEscrita\(\s*wrapToolsWithBreaker\(previewTools,/);
    expect(correcao).toMatch(/\n\s*tools,\n/);
    expect(correcao).toContain("pararQuando: () => preview.result.candidates.length > 0");
  });

  it("a aprovação continua passando pela cadeia de envio", () => {
    expect(ler("lib/agent-engine/agent/approved-reply.ts")).toContain("runBeforeSend(");
  });
});
