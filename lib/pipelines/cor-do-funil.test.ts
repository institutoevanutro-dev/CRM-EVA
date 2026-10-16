import { describe, expect, it } from "vitest";

import { PISOS, razaoDeContraste } from "@/lib/branding/contraste";
import { PALETA_DE_ETAPAS, corDaEtapaSchema } from "@/lib/kanban/cor-da-etapa";

import { PALETA_DE_FUNIS, TINTA_DO_FUNIL, estiloDoFunil } from "./cor-do-funil";

/** Os tokens de `app/globals.css` sobre os quais a linha da lista é pintada. */
const TEMAS = {
  claro: { fundo: "#f7f4ec", texto: "#171717", textoMudo: "#525252" },
  escuro: { fundo: "#0f1d18", texto: "#f1ede0", textoMudo: "#b5b09f" },
} as const;

function misturar(cor: string, fundo: string, pct: number): string {
  const c = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const canal = (i: number) =>
    Math.round((c(cor, i) * pct + c(fundo, i) * (100 - pct)) / 100)
      .toString(16)
      .padStart(2, "0");
  return `#${canal(0)}${canal(1)}${canal(2)}`;
}

describe("cor do funil", () => {
  it("são os oito tons da etapa, com o nome sem o papel da coluna", () => {
    expect(PALETA_DE_FUNIS.map((p) => p.cor)).toEqual(PALETA_DE_ETAPAS.map((p) => p.cor));
    expect(PALETA_DE_FUNIS.map((p) => p.nome)).toEqual([
      "Azul",
      "Roxo",
      "Âmbar",
      "Rosa",
      "Laranja",
      "Verde",
      "Verde-água",
      "Cinza",
    ]);
    for (const { cor } of PALETA_DE_FUNIS) expect(corDaEtapaSchema.parse(cor)).toBe(cor);
  });

  it("sem cor, a linha não ganha estilo nenhum", () => {
    expect(estiloDoFunil(null)).toBeNull();
    expect(estiloDoFunil(undefined)).toBeNull();
    expect(estiloDoFunil("")).toBeNull();
  });

  it("com cor: barra à esquerda, fundo tingido e o ponto", () => {
    expect(estiloDoFunil("#378ADD")).toEqual({
      linha: {
        boxShadow: "inset 3px 0 0 #378ADD",
        backgroundColor: `color-mix(in srgb, #378ADD ${TINTA_DO_FUNIL}%, transparent)`,
      },
      ponto: { backgroundColor: "#378ADD" },
    });
  });

  it.each(Object.entries(TEMAS))(
    "tema %s: o texto da linha tingida segue legível em todo tom da paleta",
    (_tema, { fundo, texto, textoMudo }) => {
      for (const { cor } of PALETA_DE_FUNIS) {
        const linha = misturar(cor, fundo, TINTA_DO_FUNIL);
        expect(razaoDeContraste(texto, linha), `${cor} texto`).toBeGreaterThanOrEqual(PISOS.texto);
        expect(razaoDeContraste(textoMudo, linha), `${cor} texto mudo`).toBeGreaterThanOrEqual(PISOS.texto);
      }
    },
  );
});
