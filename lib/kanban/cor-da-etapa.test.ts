import { describe, expect, it } from "vitest";

import { PISOS, razaoDeContraste } from "@/lib/branding/contraste";

import { PALETA_DE_ETAPAS, TINTA_DA_ETAPA, corDaEtapaSchema, estiloDaColuna } from "./cor-da-etapa";

/** Os tokens de `app/globals.css` sobre os quais o cabeçalho é pintado. */
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

describe("cor da etapa", () => {
  it("a forma é a do CHECK do banco; null é sem cor", () => {
    expect(corDaEtapaSchema.safeParse("#378ADD").success).toBe(true);
    expect(corDaEtapaSchema.safeParse(null).success).toBe(true);
    for (const ruim of ["378ADD", "#378AD", "#GGGGGG", "azul", ""]) {
      expect(corDaEtapaSchema.safeParse(ruim).success).toBe(false);
    }
    for (const { cor } of PALETA_DE_ETAPAS) expect(corDaEtapaSchema.parse(cor)).toBe(cor);
  });

  it("sem cor, a coluna não ganha estilo nenhum", () => {
    expect(estiloDaColuna(null)).toBeNull();
    expect(estiloDaColuna(undefined)).toBeNull();
  });

  it.each(Object.entries(TEMAS))(
    "tema %s: o texto do cabeçalho tingido segue legível em todo tom da paleta",
    (_tema, { fundo, texto, textoMudo }) => {
      for (const { cor } of PALETA_DE_ETAPAS) {
        const cabecalho = misturar(cor, fundo, TINTA_DA_ETAPA.cabecalho);
        expect(razaoDeContraste(texto, cabecalho), `${cor} texto`).toBeGreaterThanOrEqual(PISOS.texto);
        expect(razaoDeContraste(textoMudo, cabecalho), `${cor} texto mudo`).toBeGreaterThanOrEqual(
          PISOS.texto,
        );
      }
    },
  );
});
