import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { deveAbrirCasoDoFailsafe } from "@/lib/agent-engine/guardrails/failsafe-do-caso";
import {
  detectHumanHandoffPromise,
  detectHumanPromise,
} from "@/lib/agent-engine/guardrails/human-promise";

/**
 * Porte do upstream #3816 (issue #3725): o fail-safe de `case_promise_without_case`
 * só abre caso humano (e avisa o paciente da passagem) com sinal de que o paciente
 * precisa de gente, ou com promessa explícita de envolver a equipe. Conversas e
 * nomes fictícios.
 */
const PERGUNTA = { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" };
const RETOMADA = "Sem problema! Nossa equipe vai te responder outro dia.";

const abre = (cliente: string, corpo = RETOMADA) =>
  deveAbrirCasoDoFailsafe({
    mensagens: [PERGUNTA, { direction: "inbound", body: cliente }],
    corpo,
  });

describe("fail-safe de caso: o 'Não' curto não vira passagem para atendente", () => {
  it("o defeito: paciente só respondeu 'Não' e a IA prometeu retomada — NÃO abre caso", () => {
    expect(abre("Não")).toBe(false);
    expect(abre("não obrigado")).toBe(false);
    expect(abre("Pode ser semana que vem")).toBe(false);
  });

  it("a retomada continua sendo promessa vetada (o veredito do detector não muda)", () => {
    expect(detectHumanPromise(RETOMADA)).toBe(true);
    expect(detectHumanHandoffPromise(RETOMADA)).toBe(false);
    expect(detectHumanPromise("Assim que responderem eu te aviso.")).toBe(true);
    expect(detectHumanHandoffPromise("Assim que responderem eu te aviso.")).toBe(false);
  });

  it.each([
    "quero falar com uma pessoa",
    "tem alguém aí?",
    "me passa pra recepção",
    "preciso falar com a doutora",
    "preciso de ajuda",
    "quero fazer uma reclamação",
    "isso é um absurdo",
    "quero cancelar",
  ])("paciente pede gente ou reclama ('%s') — abre caso", (msg) => {
    expect(abre(msg)).toBe(true);
  });

  it.each([
    "estou com muita dor depois do procedimento",
    "tá sangrando um pouco",
    "acordei com febre",
    "deu alergia no rosto",
    "ficou muito inchado e vermelho",
    "é urgente",
    "não consigo respirar direito",
  ])("urgência ou sintoma ('%s') — abre caso, mesmo com a IA só prometendo retomada", (msg) => {
    expect(abre(msg)).toBe(true);
  });

  it.each([
    "Já encaminhei para a equipe.",
    "Vou transferir para o setor responsável.",
    "Vou verificar com a recepção e te aviso.",
    "Nossa equipe vai verificar seu comprovante.",
    "A equipe vai entrar em contato com você.",
    "Assim que a equipe conferir eu te aviso.",
    "Está em análise pela equipe.",
  ])("promessa explícita de envolver a equipe ('%s') — abre caso mesmo após 'Não'", (corpo) => {
    expect(abre("Não", corpo)).toBe(true);
  });

  it("palavra-chave de passagem do agente, do lado do paciente, abre caso", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: [{ direction: "inbound", body: "quero o orçamento do implante" }],
        corpo: RETOMADA,
        alvosExtras: ["orçamento do implante"],
      }),
    ).toBe(true);
  });

  it("sinal só da IA (outbound) não conta como pedido do paciente", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: [
          { direction: "outbound", body: "Quer falar com uma pessoa da equipe?" },
          { direction: "inbound", body: "Não" },
        ],
        corpo: RETOMADA,
      }),
    ).toBe(false);
  });

  it("fiação: o turno consulta a régua antes do auto-abre-caso", () => {
    const fonte = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const i = fonte.indexOf("chain.code === 'case_promise_without_case'");
    const guarda = fonte.indexOf("if (!podeAbrirCasoNoFailsafe)", i);
    const abreCaso = fonte.indexOf("const auto = await openCase(", i);
    expect(i).toBeGreaterThan(-1);
    expect(guarda).toBeGreaterThan(i);
    expect(guarda).toBeLessThan(abreCaso);
  });
});
