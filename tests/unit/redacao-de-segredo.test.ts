/**
 * NENHUMA CHAVE DE PROVEDOR CHEGA À TELA NEM À TELEMETRIA.
 *
 * `llm_calls.error_message` é lido pela tela de Execuções, e o texto de erro de
 * um provedor às vezes ecoa o que recebeu — inclusive o cabeçalho com a chave.
 * `redigirMensagemDoProvedor` existe para trocar a chave por `[CHAVE]`.
 *
 * Os quatro padrões dele NUNCA casaram: o arquivo tinha o byte de backspace
 * (0x08) onde devia estar `\b`, e o regex exigia um backspace antes da chave.
 * Nenhum teste os exercitava — o defeito apareceu ao escrever o caso da chave
 * do Jev.
 */
import { describe, expect, it } from "vitest";

import { redigirMensagemDoProvedor } from "@/lib/agent-engine/edge/llm/run-model-call";

describe("as chaves dos provedores são redigidas", () => {
  it.each([
    ["Anthropic", "sk-ant-api03-AbCdEfGhIjKlMnOp"],
    ["OpenRouter", "sk-or-v1-0123456789abcdef"],
    ["Google", "AIzaSyA-0123456789abcdefgh"],
  ])("%s solta no texto", (_nome, chave) => {
    const saida = redigirMensagemDoProvedor(`chave recusada: ${chave}`);
    expect(saida).not.toContain(chave);
    expect(saida).toContain("[CHAVE]");
  });

  it.each([
    ["Authorization: Bearer tok_abcdefghijklmnop"],
    ["bearer tok_abcdefghijklmnop"],
    ["x-api-key=tok_abcdefghijklmnop"],
  ])("o cabeçalho ecoado: %s", (texto) => {
    // Só letras no token de propósito: com dígitos, o padrão de TELEFONE do
    // `scrubMessage` apagava o trecho e o caso passava sem este redator agir.
    const saida = redigirMensagemDoProvedor(texto);
    expect(saida).not.toContain("tok_abcdefghijklmnop");
  });
});
