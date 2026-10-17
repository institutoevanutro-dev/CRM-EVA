import { describe, it, expect } from "vitest";
import { renderTemplate } from "@/lib/automation/template";

const ctx = {
  contact: { name: "Ana" },
  lead: { title: "Pedido X", custom_fields: { cupom: "BF10" } },
};

describe("renderTemplate", () => {
  it("variável simples", () => expect(renderTemplate("Oi {{contact.name}}!", ctx)).toBe("Oi Ana!"));
  it("path aninhado", () =>
    expect(renderTemplate("Use {{lead.custom_fields.cupom}}", ctx)).toBe("Use BF10"));
  it("alias {{nome}} resolve contact.name", () =>
    expect(renderTemplate("Oi {{nome}}", ctx)).toBe("Oi Ana"));
  it("variável ausente vira vazio, não '{{...}}' cru", () =>
    expect(renderTemplate("X{{lead.ghost}}Y", ctx)).toBe("XY"));
  it("espaços dentro das chaves tolerados", () =>
    expect(renderTemplate("Oi {{ contact.name }}", ctx)).toBe("Oi Ana"));
  it("{{primeiro_nome}} é a primeira palavra do nome, como no Inbox (#1616)", () =>
    expect(
      renderTemplate("Olá, {{primeiro_nome}}!", { contact: { name: "  Maria  Souza " } }),
    ).toBe("Olá, Maria!"));
  it("{{nome}} cai no nome do perfil do WhatsApp quando não há nome cadastrado", () => {
    // Contato que chega pelo WhatsApp tem `name` nulo e o nome do perfil em
    // `display_name`: a regra de "Novo lead" saía "Olá , ..." no 1º contato.
    const doWhatsApp = { contact: { name: null, display_name: "Paciente Exemplo" } };
    expect(renderTemplate("Olá {{nome}},", doWhatsApp)).toBe("Olá Paciente Exemplo,");
    expect(renderTemplate("Olá {{primeiro_nome}},", doWhatsApp)).toBe("Olá Paciente,");
    expect(renderTemplate("Olá {{contact.name}},", doWhatsApp)).toBe("Olá Paciente Exemplo,");
  });
  it("nome cadastrado ganha do nome do perfil", () =>
    expect(
      renderTemplate("Oi {{nome}}", { contact: { name: "Ana", display_name: "Celular da Ana" } }),
    ).toBe("Oi Ana"));
  it("sem nome de gente, o nome sai com a pontuação em volta (régua do follow-up), nunca 'Olá , '", () => {
    const lid = { contact: { name: null, display_name: "59782320914646@lid" } };
    expect(renderTemplate("Olá {{nome}}, tudo bem?", lid)).toBe("Olá, tudo bem?");
    expect(renderTemplate("Olá, {{primeiro_nome}}!", {})).toBe("Olá!");
    expect(renderTemplate("{{primeiro_nome}}, sua consulta é amanhã.", {})).toBe("Sua consulta é amanhã.");
    expect(renderTemplate("{{primeiro_nome}}", { contact: { name: null } })).toBe("");
  });
  it("no e-mail em HTML, o nome do perfil é escapado e a falta não deixa rastro", () => {
    const html = (v: string) => v.replace(/</g, "&lt;");
    expect(renderTemplate("<p>Olá {{nome}},</p>", { contact: { display_name: "<b>X</b>" } }, html)).toBe(
      "<p>Olá &lt;b>X&lt;/b>,</p>",
    );
    expect(renderTemplate("<p>Olá {{nome}},</p>", {}, html)).toBe("<p>Olá,</p>");
  });
});
