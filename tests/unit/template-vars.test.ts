import { describe, expect, it } from "vitest";

import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { interpolateTemplate } from "@/lib/inbox/template-vars";

describe("interpolateTemplate", () => {
  it("substitui nome e primeiro_nome", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}, tudo bem?", { name: "Rafael Melgaço" })).toBe(
      "Oi Rafael, tudo bem?",
    );
    expect(interpolateTemplate("Falo com {{nome}}?", { name: "Rafael Melgaço" })).toBe(
      "Falo com Rafael Melgaço?",
    );
  });
  it("tolera espaços e case nas chaves", () => {
    expect(interpolateTemplate("Oi {{ Primeiro_Nome }}!", { name: "Ana Paula" })).toBe("Oi Ana!");
  });
  it("sem nome → mantém o literal (não quebra)", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: null })).toBe("Oi {{primeiro_nome}}");
  });
  it("variável desconhecida → mantém o literal", () => {
    expect(interpolateTemplate("Cupom {{codigo}}", { name: "X" })).toBe("Cupom {{codigo}}");
  });
});

describe("interpolateTemplate · sem nome no follow-up (semValor: 'remover')", () => {
  const remover = (texto: string) => interpolateTemplate(texto, { name: null }, { semValor: "remover" });

  it.each([
    ["Ei, {{primeiro_nome}}, tá por aí?", "Ei, tá por aí?"],
    ["Olá, {{nome}}.", "Olá."],
    ["Oi {{nome}}, tudo bem?", "Oi, tudo bem?"],
    ["{{primeiro_nome}}, tudo certo?", "Tudo certo?"],
    ["Oi {{nome}}! Tudo bem?", "Oi! Tudo bem?"],
    ["{{primeiro_nome}}! Tudo bem?", "Tudo bem?"],
    ["{{nome}} tudo certo?", "Tudo certo?"],
  ])("%s → %s", (texto, esperado) => {
    expect(remover(texto)).toBe(esperado);
  });

  it("com nome, troca normalmente mesmo em 'remover'", () => {
    expect(interpolateTemplate("Ei, {{primeiro_nome}}, tá por aí?", { name: "João Lima" }, { semValor: "remover" })).toBe(
      "Ei, João, tá por aí?",
    );
  });

  it("variável desconhecida continua literal em 'remover'", () => {
    expect(remover("Cupom {{codigo}} para {{nome}}.")).toBe("Cupom {{codigo}} para.");
  });

  it("display_name técnico (telefone/@lid) conta como sem nome e sai do texto", () => {
    for (const tecnico of ["5511999998888", "543134@lid"]) {
      const nome = nomeDoContato({ name: null, display_name: tecnico });
      expect(interpolateTemplate("Ei, {{primeiro_nome}}, tá por aí?", { name: nome }, { semValor: "remover" })).toBe(
        "Ei, tá por aí?",
      );
    }
  });

  it("o nome do perfil (display_name) preenche quando não há name", () => {
    const nome = nomeDoContato({ name: "  ", display_name: "Ana Souza" });
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: nome })).toBe("Oi Ana");
  });

  it("controle da caixa de entrada: sem nome, o padrão 'manter' deixa o literal", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: null })).toBe("Oi {{primeiro_nome}}");
  });
});
