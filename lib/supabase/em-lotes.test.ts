import { describe, expect, it } from "vitest";
import { IDS_POR_LOTE, buscaEmLotes } from "./em-lotes";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("buscaEmLotes", () => {
  it("lista vazia não consulta nada", async () => {
    let chamadas = 0;
    const r = await buscaEmLotes([], async () => {
      chamadas++;
      return { data: [], error: null };
    });
    expect(r).toEqual({ data: [], error: null });
    expect(chamadas).toBe(0);
  });

  it("nenhum lote passa do teto e todos os ids chegam, na ordem", async () => {
    // 415: o funil real que parou de abrir.
    const vistos: string[][] = [];
    const r = await buscaEmLotes(ids(415), async (lote) => {
      vistos.push(lote);
      return { data: lote, error: null };
    });
    expect(vistos.every((l) => l.length <= IDS_POR_LOTE)).toBe(true);
    expect(vistos).toHaveLength(Math.ceil(415 / IDS_POR_LOTE));
    expect(r.data).toEqual(ids(415));
    expect(r.error).toBeNull();
  });

  it("o lote cabe no teto de 16 KB de header do Node, com folga", () => {
    // 36 do uuid + 3 da vírgula codificada (%2C). 404 uuids (~16 KB) é o teto medido.
    expect(IDS_POR_LOTE * 39).toBeLessThanOrEqual(12 * 1024);
  });

  it("erro em qualquer lote vira erro do todo, não resultado parcial", async () => {
    const r = await buscaEmLotes(ids(IDS_POR_LOTE * 2 + 50), async (lote) =>
      lote[0] === `id-${IDS_POR_LOTE}`
        ? { data: null, error: { message: "fetch failed" } }
        : { data: lote, error: null },
    );
    expect(r).toEqual({ data: [], error: { message: "fetch failed" } });
  });
});
