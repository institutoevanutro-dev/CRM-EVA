import { describe, expect, it } from "vitest";
import { acaoPrincipalDaConversa } from "./acao-principal";

const base = { encerrada: false, minha: false, semDono: false, podeDevolver: false };

describe("acaoPrincipalDaConversa — um botão por estado (I3)", () => {
  it("sem dono → Assumir", () => {
    expect(acaoPrincipalDaConversa({ ...base, semDono: true })).toBe("assumir");
  });
  it("sem dono e com trava do contato → Assumir continua sendo o principal", () => {
    expect(acaoPrincipalDaConversa({ ...base, semDono: true, podeDevolver: true })).toBe("assumir");
  });
  it("pausa em vigor numa conversa de colega → Devolver ao automático", () => {
    expect(acaoPrincipalDaConversa({ ...base, podeDevolver: true })).toBe("devolver");
  });
  it("encerrada → Reabrir, mesmo sem dono e com trava pendurada", () => {
    expect(acaoPrincipalDaConversa({ ...base, encerrada: true, semDono: true, podeDevolver: true })).toBe("reabrir");
  });
  it("minha → nenhum, mesmo com a pausa que o próprio assumir gravou", () => {
    expect(acaoPrincipalDaConversa({ ...base, minha: true, podeDevolver: true })).toBeNull();
  });
  it("de colega com o automático de pé → nenhum", () => {
    expect(acaoPrincipalDaConversa(base)).toBeNull();
  });
});
