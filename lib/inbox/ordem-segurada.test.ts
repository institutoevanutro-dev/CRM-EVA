import { describe, expect, it } from "vitest";

import { ordemSegurada } from "./ordem-segurada";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const lista = (...xs: string[]) => xs.map((id) => ({ id }));

describe("ordemSegurada — a lista não pula sob o mouse (item 40)", () => {
  it("sem mouse em cima, a ordem é a do servidor", () => {
    expect(ordemSegurada(lista("b", "a", "c"), null)).toEqual({ exibidos: lista("b", "a", "c"), novidades: 0 });
  });

  it("⭐ mensagem nova em 'c' (sobe ao topo): a ordem fica, e conta como novidade", () => {
    const r = ordemSegurada(lista("c", "a", "b"), ["a", "b", "c"]);
    expect(ids(r.exibidos)).toEqual(["a", "b", "c"]);
    expect(r.novidades).toBe(1);
  });

  it("conversa nova no topo espera; a que chega no fim ('Carregar mais') entra", () => {
    const r = ordemSegurada(lista("nova", "a", "b", "antiga"), ["a", "b"]);
    expect(ids(r.exibidos)).toEqual(["a", "b", "antiga"]);
    expect(r.novidades).toBe(1);
  });

  it("quem some da lista sai, sem deixar buraco", () => {
    const r = ordemSegurada(lista("a", "c"), ["a", "b", "c"]);
    expect(ids(r.exibidos)).toEqual(["a", "c"]);
    expect(r.novidades).toBe(0);
  });
});
