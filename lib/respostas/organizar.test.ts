import { describe, expect, it } from "vitest";

import { agruparPorAssunto, casaComBusca, pedacosDoTexto, separarAssunto } from "./organizar";

describe("respostas rápidas: organizar", () => {
  it("separa o assunto do nome pelo primeiro ' · '", () => {
    expect(separarAssunto("ATENDIMENTO · Sem resposta 3 · Dúvida")).toEqual({
      assunto: "ATENDIMENTO",
      nome: "Sem resposta 3 · Dúvida",
    });
    expect(separarAssunto("Boas-vindas")).toEqual({ assunto: null, nome: "Boas-vindas" });
  });

  it("agrupa pelo assunto sem diferenciar caixa, e o que não tem assunto vai por último", () => {
    const g = agruparPorAssunto([
      { title: "Solta" },
      { title: "ATENDIMENTO · A" },
      { title: "Agenda · B" },
      { title: "atendimento · C" },
    ]);
    expect(g.map((x) => [x.assunto, x.itens.map((i) => i.nome)])).toEqual([
      ["ATENDIMENTO", ["A", "C"]],
      ["Agenda", ["B"]],
      [null, ["Solta"]],
    ]);
  });

  it("busca sem acento no título e no texto", () => {
    const r = { title: "ATENDIMENTO · Dúvida", body: "Ficou alguma dúvida?" };
    expect(casaComBusca(r, "duvida")).toBe(true);
    expect(casaComBusca(r, "boleto")).toBe(false);
    expect(casaComBusca(r, "  ")).toBe(true);
  });

  it("desenha {{variavel}} como rótulo legível", () => {
    expect(pedacosDoTexto("Olá, {{primeiro_nome}}! Tudo certo?")).toEqual([
      { tipo: "texto", valor: "Olá, " },
      { tipo: "variavel", valor: "Primeiro nome" },
      { tipo: "texto", valor: "! Tudo certo?" },
    ]);
  });
});
