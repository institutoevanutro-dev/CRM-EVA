import { expect, it } from "vitest";
import { regraQueCasa, RegraDeComentario } from "./regra";

const r = (palavra: string, extra: Partial<RegraDeComentario> = {}): RegraDeComentario => ({
  id: palavra,
  mediaId: "m1",
  palavra,
  textoDoDirect: "link",
  frasePublica: "te mandei",
  criadaEm: "2026-09-01T00:00:00Z",
  ...extra,
});

it("casa sem acento e sem caixa", () => {
  expect(regraQueCasa("CARDAPIO", [r("cardápio")])?.id).toBe("cardápio");
  expect(regraQueCasa("quero o cardápio!", [r("CARDAPIO")])?.id).toBe("CARDAPIO");
});

it("casa PALAVRA INTEIRA: não dispara dentro de outra palavra", () => {
  expect(regraQueCasa("cardápios da vovó", [r("cardápio")])).toBeNull();
  expect(regraQueCasa("descardapio", [r("cardapio")])).toBeNull();
});

it("pontuação colada não atrapalha", () => {
  expect(regraQueCasa("CARDÁPIO, por favor", [r("cardapio")])?.id).toBe("cardapio");
});

it("duas regras casando: vence a palavra mais longa; empate, a mais antiga", () => {
  expect(regraQueCasa("quero o plano premium", [r("plano"), r("plano premium")])?.palavra).toBe("plano premium");
  const a = r("plano", { id: "antiga", criadaEm: "2026-01-01T00:00:00Z" });
  const b = r("guia", { id: "nova", criadaEm: "2026-05-01T00:00:00Z" });
  expect(regraQueCasa("plano e guia", [b, a])?.id).toBe("antiga");
});

it("texto vazio, nulo ou só emoji não casa nada", () => {
  expect(regraQueCasa(null, [r("cardapio")])).toBeNull();
  expect(regraQueCasa("   ", [r("cardapio")])).toBeNull();
  expect(regraQueCasa("🔥🔥", [r("cardapio")])).toBeNull();
});

it("regra com palavra vazia não casa nada", () => {
  expect(regraQueCasa("Bom dia!", [r("")])).toBeNull();
  expect(regraQueCasa("oi  tudo", [r("   ")])).toBeNull();
  expect(regraQueCasa("Quero o cardapio.", [r("")])).toBeNull();
});

it("palavra composta casa com espaçamento diferente", () => {
  expect(regraQueCasa("quero plano  premium", [r("plano premium")])?.id).toBe("plano premium");
  expect(regraQueCasa("quero plano\npremium", [r("plano premium")])?.id).toBe("plano premium");
  expect(regraQueCasa("quero plano\tpremium", [r("plano premium")])?.id).toBe("plano premium");
});

it("emoji colado na palavra não atrapalha", () => {
  expect(regraQueCasa("🔥CARDAPIO🔥", [r("cardapio")])?.id).toBe("cardapio");
});
