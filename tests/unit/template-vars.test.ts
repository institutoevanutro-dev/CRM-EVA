import { describe, expect, it } from "vitest";

import { interpolateTemplate, variaveisDesconhecidas, VARIAVEIS_DO_TEMPLATE } from "@/lib/inbox/template-vars";

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
    // Começo de linha que não é a do texto: a quebra fica, a linha não cola na anterior.
    ["Olá! 😊\n\n{{primeiro_nome}}, passando para lembrar da consulta.", "Olá! 😊\n\nPassando para lembrar da consulta."],
    ["Bom dia!\n{{nome}} tudo certo?", "Bom dia!\nTudo certo?"],
    ["Olá!\n{{nome}}\nTudo bem?", "Olá!\nTudo bem?"],
    // Entre parênteses: saem juntos.
    ["Olá ({{nome}})", "Olá"],
    ["Olá ({{nome}}), tudo bem?", "Olá, tudo bem?"],
    // Nada além da variável: texto vazio — quem chama não envia.
    ["{{primeiro_nome}}", ""],
    ["{{nome}}?", ""],
    // Sobra só pontuação em volta: também é vazio.
    ["— {{nome}} —", ""],
  ])("%s → %s", (texto, esperado) => {
    expect(remover(texto)).toBe(esperado);
  });

  it("com nome, troca normalmente mesmo em 'remover'", () => {
    expect(interpolateTemplate("Ei, {{primeiro_nome}}, tá por aí?", { name: "João Lima" }, { semValor: "remover" })).toBe(
      "Ei, João, tá por aí?",
    );
  });

  it("variável desconhecida também sai em 'remover': o paciente nunca recebe chaves", () => {
    expect(remover("Cupom {{codigo}} para {{nome}}.")).toBe("Cupom para.");
    expect(remover("Oi {{nomee}}, tudo bem?")).toBe("Oi, tudo bem?");
    expect(remover("Oi {{primeiro nome}}! Faltam {{1}} dias.")).toBe("Oi! Faltam dias.");
  });

  it("display_name técnico (telefone/@lid) conta como sem nome e sai do texto", () => {
    for (const tecnico of ["5511999998888", "543134@lid"]) {
      expect(
        interpolateTemplate("Ei, {{primeiro_nome}}, tá por aí?", { name: null, display_name: tecnico }, { semValor: "remover" }),
      ).toBe("Ei, tá por aí?");
    }
  });

  it("o nome do perfil (display_name) preenche quando não há name — o helper resolve, não quem chama", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: "  ", display_name: "Ana Souza" })).toBe("Oi Ana");
  });

  it("controle da caixa de entrada: sem nome, o padrão 'manter' deixa o literal", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}", { name: null })).toBe("Oi {{primeiro_nome}}");
  });
});

describe("interpolateTemplate · telefone e e-mail", () => {
  const pessoa = {
    name: "Ana Paula Souza",
    display_name: null,
    phone_number: "+5527999990000",
    email: "ana@exemplo.com",
    lead_title: "Avaliação nutricional",
  };
  const enviar = (texto: string, contato: Record<string, unknown> = pessoa) =>
    interpolateTemplate(texto, contato, { semValor: "remover" });

  it("preenche cada variável da lista, com e sem o prefixo contact.", () => {
    expect(enviar("{{primeiro_nome}}, seu número é {{telefone}} e o e-mail {{email}}?")).toBe(
      "Ana, seu número é +5527999990000 e o e-mail ana@exemplo.com?",
    );
    expect(enviar("{{contact.name}} / {{contact.phone_number}} / {{contact.email}}")).toBe(
      "Ana Paula Souza / +5527999990000 / ana@exemplo.com",
    );
  });

  it("sem valor: a variável sai com a pontuação, nunca 'null' nem 'undefined'", () => {
    const semDados = { name: "Ana", phone_number: null, email: "  " };
    const texto = enviar("Oi {{primeiro_nome}}, confirma o e-mail {{email}} e o número {{telefone}}?", semDados);
    expect(texto).not.toMatch(/[{}]|null|undefined/);
    expect(texto).toBe("Oi Ana, confirma o e-mail e o número?");
    expect(enviar("{{email}}", semDados)).toBe("");
  });

  it("no Inbox (manter), o que não tem valor continua literal para quem envia ver", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}, {{telefone}}", { name: "Ana" })).toBe("Oi Ana, {{telefone}}");
  });

  it("{{lead.title}} NÃO é variável: o título do negócio não sai mesmo quando existe", () => {
    expect(enviar("Oi {{primeiro_nome}}, sobre {{lead.title}}: tudo certo?")).toBe("Oi Ana, sobre: tudo certo?");
    expect(variaveisDesconhecidas("{{lead.title}}")).toEqual(["{{lead.title}}"]);
  });

  it("a lista é FECHADA: nada de CPF, nascimento, observação ou campo personalizado", () => {
    expect([...VARIAVEIS_DO_TEMPLATE]).toEqual(["primeiro_nome", "nome", "telefone", "email"]);
    // Mesmo com a linha inteira do banco na mão, só a lista sai.
    const linhaInteira = {
      ...pessoa,
      birthdate: "1990-01-02",
      cpf_hash: "abc123",
      blocked_reason: "motivo interno",
      description: "observação clínica",
      lost_reason: "achou caro",
      custom_fields: { diagnostico: "diabetes" },
      tags: ["gestante"],
    };
    const texto = enviar(
      "{{contact.birthdate}} {{birthdate}} {{contact.cpf_hash}} {{cpf}} {{contact.blocked_reason}} {{lead.description}} {{lead.title}} " +
        "{{lead.lost_reason}} {{lead.custom_fields.diagnostico}} {{diagnostico}} {{contact.tags}} {{constructor}} {{__proto__}} fim",
      linhaInteira,
    );
    expect(texto).toBe("Fim");
  });

  it("variaveisDesconhecidas: aponta o erro de digitação e aceita as extras de quem chama", () => {
    expect(variaveisDesconhecidas("Oi {{nome}} {{nomee}} {{ Telefone }} {{volta}}")).toEqual(["{{nomee}}", "{{volta}}"]);
    expect(variaveisDesconhecidas("Oi {{nomee}} {{volta}}", ["volta", "voltas"])).toEqual(["{{nomee}}"]);
    expect(variaveisDesconhecidas("Oi {{contact.email}} e {{contact.name}}")).toEqual([]);
  });
});
