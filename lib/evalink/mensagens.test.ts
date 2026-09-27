import { describe, expect, it } from "vitest";

import { MENSAGENS_EVALINK, mensagemDoEvalink } from "./mensagens";

describe("mensagemDoEvalink", () => {
  it("devolve a mensagem para cada motivo conhecido", () => {
    for (const chave of Object.keys(MENSAGENS_EVALINK)) {
      expect(mensagemDoEvalink(chave)).toBe(MENSAGENS_EVALINK[chave]);
    }
  });

  it("devolve undefined para motivo desconhecido", () => {
    expect(mensagemDoEvalink("nao_existe")).toBeUndefined();
  });

  it("devolve undefined para propriedades herdadas do protótipo", () => {
    expect(mensagemDoEvalink("constructor")).toBeUndefined();
    expect(mensagemDoEvalink("__proto__")).toBeUndefined();
    expect(mensagemDoEvalink("toString")).toBeUndefined();
  });

  it("devolve undefined para valor que não é string", () => {
    expect(mensagemDoEvalink(["falhou"])).toBeUndefined();
    expect(mensagemDoEvalink(undefined)).toBeUndefined();
    expect(mensagemDoEvalink(null)).toBeUndefined();
    expect(mensagemDoEvalink(42)).toBeUndefined();
  });
});
