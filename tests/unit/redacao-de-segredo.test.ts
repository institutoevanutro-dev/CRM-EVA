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

// ─── Revisão do PR 125 ───────────────────────────────────────────────────────
//
// O conserto do backspace pegava a chave pelo PREFIXO (`sk-`, `AIza`) e o
// cabeçalho só no esquema `Bearer`. Estas formas passavam inteiras — medidas
// uma a uma: outro esquema de Authorization, o cabeçalho ecoado em JSON (as
// aspas ficam entre o nome e os dois-pontos), a chave sem prefixo conhecido
// depois de "API key:", `BEARER` em maiúsculas e a cauda em base64 do token.
describe("credencial fora dos formatos de prefixo", () => {
  // Só letras nos segredos, pelo mesmo motivo do caso de cima.
  it.each([
    ["Authorization: Basic dXNlcjpzZW5oYQ==", "dXNlcjpzZW5oYQ"],
    ["authorization: Token abcdefghijklmnop", "abcdefghijklmnop"],
    ['headers: {"x-api-key":"vck_abcdefghijklmnop"}', "vck_abcdefghijklmnop"],
    ['{"api_key": "abcdefghijklmnopqrst"}', "abcdefghijklmnopqrst"],
    ['{"Authorization":"Bearer abcdefghijklmnop"}', "abcdefghijklmnop"],
    ["Invalid API key: vck_abcdefghijklmnop", "vck_abcdefghijklmnop"],
    ["BEARER tok_abcdefghijklmnop", "tok_abcdefghijklmnop"],
    ["Bearer abcdefgh+ijkl/mnop=qrstuv==", "ijkl/mnop=qrstuv"],
  ])("%s", (texto, segredo) => {
    const saida = redigirMensagemDoProvedor(texto);
    expect(saida).not.toContain(segredo);
    expect(saida).toContain("[CHAVE]");
  });

  it("não apaga a frase que só FALA de chave", () => {
    // O que ensina o dono a consertar tem de continuar legível.
    const texto = "Incorrect API key provided. You can find your API key at the dashboard.";
    expect(redigirMensagemDoProvedor(texto)).toBe(texto);
  });
});
