import { describe, expect, it, vi } from "vitest";

import { parseCheckpointText } from "../../lib/agent-engine/agent/inbound-turn";
import {
  parseFollowupClassification,
  parsePlanoDeEsperas,
} from "../../lib/agent-engine/agent/followup-flow-classify";
import { parseIntentVerdict } from "../../lib/agent-engine/agent/intent-classifier";
import type { Logger } from "../../lib/agent-engine/obs/logger";
import { parseJailbreakClassification } from "../../lib/agent-engine/guardrails/jailbreak/classifier";
import { parsePromiseClassification } from "../../lib/agent-engine/guardrails/promise/semantic";
import { extrairObjetoJsonDoTexto } from "../../lib/agent-engine/texto/extrair-json-do-texto";
import { extrairJson } from "../../lib/onboarding/sugerir-funil";

/**
 * Os leitores de JSON de modelo que ainda recortavam "do primeiro `{` ao último
 * `}`" depois do PR 110 do fork (que só migrou compaction, intent-classifier e
 * flywheel).
 *
 * O recorte antigo abre no primeiro `{` e fecha no ÚLTIMO `}` do texto. Quando o
 * modelo REPETE o objeto (prosa + cópia 1 + prosa + cópia 2), o span contém AS
 * DUAS cópias, o `JSON.parse` lança e o leitor cai no ramo de falha dele, mesmo
 * com um JSON perfeito na primeira cópia. As duas cópias trazem valores
 * diferentes de propósito: assim o teste diz QUAL cópia foi lida.
 *
 * E a resposta inteira dentro de um array (`[{...}]`): os leitores pedem
 * OBJETO, então array no topo não é a resposta e o objeto lá dentro é achado.
 *
 * Cada leitor tem também o controle: saída sem JSON continua no ramo de falha de
 * hoje (os dois guardrails seguem fail-open).
 *
 * Portado de melgarafael/DeskcommCRM dc3d83787 e 5af05d591 (autor: webtecnica)
 * e d43bcb37e (autor: melgarafael), sem flow-validate (não existe neste fork).
 */

const RESPOSTA_EM_ARRAY = (objeto: string) => `[${objeto}]`;

describe("extrairObjetoJsonDoTexto — só devolve objeto", () => {
  it("acha o objeto dentro de um array no topo", () => {
    expect(extrairObjetoJsonDoTexto('[{"a":1}]')).toEqual({ a: 1 });
  });

  it("array sem objeto e JSON escalar não são resposta: null", () => {
    expect(extrairObjetoJsonDoTexto("[1,2]")).toBeNull();
    expect(extrairObjetoJsonDoTexto('"texto"')).toBeNull();
    expect(extrairObjetoJsonDoTexto("42")).toBeNull();
  });
});

describe("sugerir-funil — extrairJson", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Claro! Aqui está o funil sugerido:",
      "```json",
      '{"nome":"Quadro A","etapas":[{"nome":"Novo","passo":"cliente entrou"}]}',
      "```",
      "",
      "Repetindo a resposta completa:",
      '{"nome":"Quadro B","etapas":[]}',
    ].join("\n");
    expect(extrairJson(texto)).toEqual({
      nome: "Quadro A",
      etapas: [{ nome: "Novo", passo: "cliente entrou" }],
    });
  });

  it("lê a resposta inteira dentro de array", () => {
    expect(extrairJson(RESPOSTA_EM_ARRAY('{"nome":"Quadro A","etapas":[]}'))).toEqual({
      nome: "Quadro A",
      etapas: [],
    });
  });

  it("saída sem JSON continua devolvendo null", () => {
    expect(extrairJson("Desculpe, não posso ajudar com isso.")).toBeNull();
    expect(extrairJson("")).toBeNull();
  });
});

describe("resumo de fim de turno — parseCheckpointText", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o checkpoint", () => {
    const texto = [
      "Fechamento do turno:",
      '{"commitments":[],"objections":[],"next_action":"ligar amanhã","rolling_summary":"A"}',
      "",
      "Repetindo:",
      '{"commitments":[],"objections":[],"next_action":null,"rolling_summary":"B"}',
    ].join("\n");
    const cp = parseCheckpointText(texto);
    expect(cp.rolling_summary).toBe("A");
    expect(cp.next_action).toBe("ligar amanhã");
  });

  it("lê o checkpoint dentro de array", () => {
    const cp = parseCheckpointText(RESPOSTA_EM_ARRAY('{"rolling_summary":"A"}'));
    expect(cp.rolling_summary).toBe("A");
  });

  it("saída sem JSON continua lançando (o job re-tenta)", () => {
    expect(() => parseCheckpointText("não sei")).toThrow(/sem JSON de checkpoint/);
  });
});

describe("followup-flow-classify — parseFollowupClassification", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Classificação da última resposta do lead:",
      '{"class": "hot"}',
      "",
      "Repetindo a classificação:",
      '{"class": "cold"}',
    ].join("\n");
    expect(parseFollowupClassification(texto, ["hot", "cold"])).toBe("hot");
  });

  it("lê a resposta inteira dentro de array", () => {
    expect(parseFollowupClassification(RESPOSTA_EM_ARRAY('{"class":"hot"}'), ["hot", "cold"])).toBe(
      "hot",
    );
  });

  it("saída sem JSON continua devolvendo null", () => {
    expect(parseFollowupClassification("desculpe, não sei responder", ["hot", "cold"])).toBeNull();
  });
});

describe("followup-flow-classify — parsePlanoDeEsperas", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Plano de esperas proposto para o fluxo:",
      '{"esperas":[{"node_id":"n1","aguardar_ms":1000,"motivo":"primeira escolha"}]}',
      "",
      "Repetindo o plano, agora com outra espera:",
      '{"esperas":[{"node_id":"n1","aguardar_ms":7200000,"motivo":"segunda escolha"}]}',
    ].join("\n");
    expect(parsePlanoDeEsperas(texto, ["n1"])).toEqual([
      { node_id: "n1", aguardar_ms: 1000, motivo: "primeira escolha" },
    ]);
  });

  it("lê a resposta inteira dentro de array", () => {
    expect(
      parsePlanoDeEsperas(
        RESPOSTA_EM_ARRAY('{"esperas":[{"node_id":"n1","aguardar_ms":1000,"motivo":"m"}]}'),
        ["n1"],
      ),
    ).toEqual([{ node_id: "n1", aguardar_ms: 1000, motivo: "m" }]);
  });

  it("saída sem JSON continua devolvendo []", () => {
    expect(parsePlanoDeEsperas("talvez semana que vem", ["n1"])).toEqual([]);
  });
});

describe("intent-classifier — parseIntentVerdict", () => {
  it("lê a resposta inteira dentro de array", () => {
    const membros = [
      { intentName: "vendas", intentDescription: "quer comprar", agentId: "a-1", examples: [] },
    ];
    expect(
      parseIntentVerdict(RESPOSTA_EM_ARRAY('{"intent":"vendas","confidence":0.9}'), membros),
    ).toEqual({ intentName: "vendas", confidence: 0.9 });
  });
});

describe("guardrail de jailbreak — parseJailbreakClassification", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o veredito no meio da prosa", () => {
    const texto = [
      "Análise da mensagem recebida do lead:",
      '{"level": "high", "reason": "pedido de prompt"}',
      "",
      "Repetindo o veredito, agora sem o motivo:",
      '{"level": "none", "reason": null}',
    ].join("\n");
    expect(parseJailbreakClassification(texto)).toEqual({
      flag: true,
      level: "high",
      reason: "pedido de prompt",
    });
  });

  it("um `high` dentro de array continua marcado", () => {
    expect(parseJailbreakClassification(RESPOSTA_EM_ARRAY('{"level":"high","reason":"x"}'))).toEqual(
      { flag: true, level: "high", reason: "x" },
    );
  });

  it("saída sem JSON continua degradando para o veredito limpo (fail-open)", () => {
    expect(parseJailbreakClassification("só prosa, sem veredito nenhum")).toEqual({
      flag: false,
      level: "none",
      reason: null,
    });
  });
});

describe("guardrail de promessa — parsePromiseClassification", () => {
  const logCom = (warn: Logger["warn"]): Logger => ({
    info: vi.fn(),
    warn,
    error: vi.fn(),
  });

  it("lê a PRIMEIRA cópia quando o modelo repete o veredito, sem warn", () => {
    const warn = vi.fn();
    const texto = [
      "Veredito da camada semântica:",
      '{"isPromise": true, "suspectPhrase": "te dou de graça"}',
      "",
      "Repetindo o veredito:",
      '{"isPromise": false, "suspectPhrase": null}',
    ].join("\n");
    expect(parsePromiseClassification(texto, logCom(warn))).toEqual({
      isPromise: true,
      suspectPhrase: "te dou de graça",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("lê a promessa dentro de array, sem warn", () => {
    const warn = vi.fn();
    expect(
      parsePromiseClassification(
        RESPOSTA_EM_ARRAY('{"isPromise":true,"suspectPhrase":"x"}'),
        logCom(warn),
      ),
    ).toEqual({ isPromise: true, suspectPhrase: "x" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("saída sem JSON continua no fail-open de hoje, com o mesmo warn", () => {
    const semJson = vi.fn();
    expect(parsePromiseClassification("sem veredito nenhum", logCom(semJson))).toEqual({
      isPromise: false,
      suspectPhrase: null,
    });
    expect(semJson).toHaveBeenCalledWith(expect.stringContaining('fail-open p/ "sem promessa"'), {
      event: "promise_semantic_parse_fail",
      reason: "no_json",
    });

    const invalido = vi.fn();
    expect(
      parsePromiseClassification("isto aqui não fecha: {quebrado}", logCom(invalido)),
    ).toEqual({ isPromise: false, suspectPhrase: null });
    expect(invalido).toHaveBeenCalledWith(expect.stringContaining('fail-open p/ "sem promessa"'), {
      event: "promise_semantic_parse_fail",
      reason: "invalid_json",
    });
  });

  it("array sem objeto é fail-open COM o warn", () => {
    const warn = vi.fn();
    expect(parsePromiseClassification("[1,2]", logCom(warn))).toEqual({
      isPromise: false,
      suspectPhrase: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fail-open p/ "sem promessa"'), {
      event: "promise_semantic_parse_fail",
      reason: "no_json",
    });
  });
});
