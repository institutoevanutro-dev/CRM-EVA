/**
 * A busca das respostas rápidas ignora acento, nos dois sentidos, no título e
 * no atalho (#4070 do original). Vale para o menu do `/` e para a busca da barra
 * de respostas, que usam a mesma `filtrarRespostas`.
 *
 * Portado do projeto original (DeskcommCRM, PR #4079 de @webtecnica); o fork não
 * tem grupos de respostas, então os casos do nome do grupo ficaram de fora.
 */
import { describe, expect, it } from "vitest";

import { filtrarRespostas } from "@/components/inbox/composer/TemplateMenu";

const RESPOSTAS = [
  { id: "a1", title: "Orçamento", shortcut: null },
  { id: "a2", title: "Orcamento simples", shortcut: null },
  { id: "a3", title: "Prazo", shortcut: "prazo" },
];

const ids = (query: string) => filtrarRespostas(RESPOSTAS, query).map((r) => r.id);

describe("#4070 — a busca das respostas rápidas ignora acento", () => {
  it("'orcamento' acha 'Orçamento', e o título exibido mantém o acento", () => {
    const achados = filtrarRespostas(RESPOSTAS, "orcamento");
    expect(achados.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(achados[0]!.title).toBe("Orçamento");
  });

  it("'Orçamento' digitado com acento acha a resposta cadastrada sem acento", () => {
    expect(ids("Orçamento")).toEqual(["a1", "a2"]);
  });

  it("caixa e acento somados caem no mesmo lugar", () => {
    for (const grafia of ["orcamento", "Orçamento", "ORCAMENTO", "ORÇAMENTO"]) {
      expect(ids(grafia), grafia).toEqual(["a1", "a2"]);
    }
  });

  it("o atalho também casa sem acento", () => {
    const soAtalho = [{ id: "s1", title: "Mensagem comercial", shortcut: "orcamento" }];
    expect(filtrarRespostas(soAtalho, "orçamento").map((r) => r.id)).toEqual(["s1"]);
  });

  it("vazio devolve tudo na ordem; termo sem par devolve vazio", () => {
    expect(ids("")).toEqual(["a1", "a2", "a3"]);
    expect(ids("   ")).toEqual(["a1", "a2", "a3"]);
    expect(ids("zzz")).toEqual([]);
  });
});
