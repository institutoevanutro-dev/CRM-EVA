/**
 * A RÉGUA COMUM DA BUSCA DE CONTATO — o que ela tem de cobrir.
 *
 * O defeito que esta função fechou foi uma coluna faltando no OR: a agenda
 * buscava só `name`, e todo contato vindo do WhatsApp tem o nome em
 * `display_name`. Por isso o primeiro caso não é "a string contém display_name"
 * como símbolo solto — é a condição exata, com o termo dentro.
 */
import { describe, expect, it } from "vitest";

import { condicoesDaBuscaDeContato } from "./busca";

describe("condicoesDaBuscaDeContato", () => {
  it("busca no nome do WhatsApp (display_name), não só em name", () => {
    const c = condicoesDaBuscaDeContato("André Teste");
    expect(c).toContain("display_name.ilike.%André Teste%");
    expect(c).toContain("name.ilike.%André Teste%");
    expect(c).toContain("email.ilike.%André Teste%");
    expect(c).toContain("phone_number.ilike.%André Teste%");
  });

  it("termo vazio ou só espaço não vira 'todo mundo'", () => {
    expect(condicoesDaBuscaDeContato("")).toEqual([]);
    expect(condicoesDaBuscaDeContato("   ")).toEqual([]);
  });

  it("vírgula e parênteses não injetam condição no DSL do .or()", () => {
    const c = condicoesDaBuscaDeContato("Silva, Maria (filha)");
    for (const cond of c) {
      // Cada condição tem de ser UMA: `coluna.ilike.valor`, sem vírgula solta.
      expect(cond).not.toContain(",");
      expect(cond).not.toMatch(/[()]/);
    }
  });

  it("% e _ digitados são literais, não curingas do LIKE", () => {
    const c = condicoesDaBuscaDeContato("50%_off");
    expect(c).toContain("name.ilike.%50\\%\\_off%");
  });

  it("telefone sem DDI acha o cadastro com +55 e com/sem o nono dígito", () => {
    // O cadastro real está como +5527999990001; quem marca digita sem o 55.
    const c = condicoesDaBuscaDeContato("27999990001");
    expect(c).toContain("phone_number.ilike.%5527999990001%");
    // Variante sem o nono dígito, para celular antigo gravado com 12 dígitos.
    expect(c).toContain("phone_number.ilike.%552799990001%");
  });

  it("não monta variante de telefone para texto curto", () => {
    const c = condicoesDaBuscaDeContato("1234");
    expect(c).toHaveLength(4);
  });
});
