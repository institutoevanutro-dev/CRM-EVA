/**
 * RESPOSTA CORTADA NO TETO DE TOKENS — nunca vai ao cliente, e não morre calada
 * (porte do upstream DeskcommCRM #2938).
 *
 * Duas garantias, de donos diferentes:
 * - o AI SDK não executa ferramenta de um passo que terminou em `length`: um
 *   `send_message` com o texto pela metade não sai. É do SDK, não nosso — e por
 *   isso está preso aqui: se uma atualização do `ai` mudar a regra, este teste
 *   reprova antes de um paciente receber "Olá, sua consulta est";
 * - o motor sabe distinguir o silêncio cortado (falha, vira aviso na Central) do
 *   silêncio deliberado (decisão, não avisa): `turnoMudoPorCorte`.
 *
 * O caminho inteiro, com o handler de `inbound_turn` e o Postgres do baseline,
 * está em `tests/invariants/turno-mudo-pede-uma-correcao.test.ts`.
 */
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { semChamadasSemResultado, turnoMudoPorCorte } from "@/lib/agent-engine/agent/turno-mudo";

async function enviadosCom(finish: "length" | "tool-calls"): Promise<string[]> {
  const enviados: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        { type: "tool-call", toolCallId: "t1", toolName: "send_message", input: JSON.stringify({ body: "Olá, sua consulta est" }) },
      ],
      finishReason: { unified: finish, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  await generateText({
    model,
    prompt: "oi",
    tools: {
      send_message: tool({
        inputSchema: z.object({ body: z.string() }),
        execute: async ({ body }) => {
          enviados.push(body);
          return "ok";
        },
      }),
    },
    stopWhen: stepCountIs(1),
  });
  return enviados;
}

describe("a resposta cortada no teto de tokens não sai", () => {
  it("⭐ send_message de um passo que terminou em `length` não executa", async () => {
    expect(await enviadosCom("length")).toEqual([]);
  });

  it("controle: o mesmo send_message num passo normal executa", async () => {
    expect(await enviadosCom("tool-calls")).toEqual(["Olá, sua consulta est"]);
  });
});

const MUDO = {
  tentativasDeEnvio: 0,
  enviadas: 0,
  turnoDescartado: false,
  passouParaAEquipe: false,
  capDeEnvio: false,
  saidaCortada: false,
  correcaoCortada: false,
};

describe("o turno mudo por corte vira aviso; o silêncio deliberado, não", () => {
  it.each([
    ["a resposta principal foi cortada", { saidaCortada: true }],
    ["a correção também foi cortada", { correcaoCortada: true }],
  ])("⭐ %s e nada saiu: avisa", (_caso, mudanca) => {
    expect(turnoMudoPorCorte({ ...MUDO, ...mudanca })).toBe(true);
  });

  it("silêncio sem corte é decisão do modelo: não avisa", () => {
    expect(turnoMudoPorCorte(MUDO)).toBe(false);
  });

  it.each([
    ["a correção recuperou e algo saiu", { enviadas: 1 }],
    ["o modelo tentou enviar e levou veto", { tentativasDeEnvio: 1 }],
    ["o turno foi descartado como obsoleto", { turnoDescartado: true }],
    ["a conversa foi passada à equipe", { passouParaAEquipe: true }],
    ["o teto de envio do número barrou", { capDeEnvio: true }],
  ])("cortado, mas com razão para o silêncio — %s: não avisa", (_razao, mudanca) => {
    expect(turnoMudoPorCorte({ ...MUDO, saidaCortada: true, ...mudanca })).toBe(false);
  });
});

describe("a correção do turno cortado não reenvia a chamada sem resultado", () => {
  it("⭐ tira a chamada que o passo cortado não executou e mantém o resto da fita", () => {
    const fita = [
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "a", toolName: "check_agenda", input: {} }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "a", toolName: "check_agenda", output: { type: "text" as const, value: "livre às 10h" } }] },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Vou confirmar" },
          { type: "tool-call" as const, toolCallId: "b", toolName: "send_message", input: { body: "Olá, sua consulta est" } },
        ],
      },
    ];
    expect(semChamadasSemResultado(fita)).toEqual([
      fita[0],
      fita[1],
      { role: "assistant", content: [{ type: "text", text: "Vou confirmar" }] },
    ]);
  });

  it("a mensagem do assistente que só tinha a chamada cortada sai inteira", () => {
    const fita = [
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "b", toolName: "send_message", input: {} }] },
    ];
    expect(semChamadasSemResultado(fita)).toEqual([]);
  });
});
