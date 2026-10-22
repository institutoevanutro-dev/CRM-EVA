import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { derivarMarca, extrairRegua } from "@/lib/branding/contraste";
import { PALETAS, paletaDaCor } from "@/lib/branding/paletas";

const REGUA = extrairRegua(fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8"));

describe("paletas do guia de marca", () => {
  it("são as 6 do guia, na ordem e com os valores do guia", () => {
    expect(PALETAS.map((p) => [p.id, p.nome, p.principal])).toEqual([
      ["verde-dourado", "Verde e dourado", "#27463b"],
      ["azul-petroleo", "Azul-petróleo", "#1f4e5f"],
      ["vinho", "Vinho", "#6b2737"],
      ["grafite", "Grafite", "#3a3f47"],
      ["terracota", "Terracota", "#8a3f26"],
      ["lavanda", "Lavanda", "#4f3f7a"],
    ]);
  });

  it("paletaDaCor acha cada uma, sem ligar para maiúsculas, espaços ou cerquilha", () => {
    for (const p of PALETAS) {
      expect(paletaDaCor(p.principal)).toBe(p.id);
      expect(paletaDaCor(` ${p.principal.toUpperCase()} `)).toBe(p.id);
      expect(paletaDaCor(p.principal.slice(1))).toBe(p.id);
    }
  });

  it("paletaDaCor devolve null para outra cor, vazio ou texto que não é cor", () => {
    for (const v of ["#506d48", "", "#12", "vinho", "#zzzzzz", "#6b2738"])
      expect(paletaDaCor(v)).toBeNull();
  });

  it("cada principal passa nos pisos de contraste do CRM nos dois temas", () => {
    for (const p of PALETAS) {
      const marca = derivarMarca(p.principal, REGUA);
      for (const tema of [marca.claro, marca.escuro] as const) {
        expect(tema.pares.length, `${p.id}: nenhum par medido`).toBeGreaterThanOrEqual(18);
        const reprovas = tema.pares.filter((par) => !par.passa);
        expect(
          reprovas,
          `${p.id}: ${reprovas.map((r) => `${r.papel}×${r.superficie}=${r.razao.toFixed(2)}`).join(", ")}`,
        ).toEqual([]);
      }
    }
  });
});
