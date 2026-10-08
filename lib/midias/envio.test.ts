import { describe, expect, it } from "vitest";

import { escolherVariante, tipoDaMidia } from "./envio";
import type { Variante } from "./termo";

const A: Variante = { key: "A", storage_path: "o/i/A.jpg", mime: "image/jpeg", size_bytes: 10 };
const B: Variante = { key: "B", storage_path: "o/i/B.jpg", mime: "image/jpeg", size_bytes: 20 };

describe("escolherVariante", () => {
  it("devolve a variante pedida quando ela existe", () => {
    expect(escolherVariante([A, B], "contato-1", "B")).toBe(B);
    expect(escolherVariante([A, B], "contato-1", "A")).toBe(A);
  });
  it("pedida ausente cai no sorteio entre as que existem", () => {
    expect(escolherVariante([A], "contato-1", "B")).toBe(A);
  });
  it("o sorteio é estável para o mesmo contato e não depende da ordem gravada", () => {
    const primeira = escolherVariante([A, B], "contato-x");
    for (let i = 0; i < 5; i++) expect(escolherVariante([B, A], "contato-x")).toBe(primeira);
  });
  it("o sorteio distribui entre contatos", () => {
    const chaves = new Set(Array.from({ length: 40 }, (_, i) => escolherVariante([A, B], `c-${i}`)?.key));
    expect(chaves).toEqual(new Set(["A", "B"]));
  });
  it("sem variante devolve null", () => {
    expect(escolherVariante([], "contato-1")).toBeNull();
    expect(escolherVariante([], "contato-1", "A")).toBeNull();
  });
});

describe("tipoDaMidia", () => {
  it("imagens viram image", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp"]) expect(tipoDaMidia(m)).toBe("image");
  });
  it("vídeos viram video", () => {
    for (const m of ["video/mp4", "video/3gpp"]) expect(tipoDaMidia(m)).toBe("video");
  });
  it("o resto é null", () => {
    expect(tipoDaMidia("application/pdf")).toBeNull();
  });
});
