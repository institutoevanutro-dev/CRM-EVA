import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { razaoDeContraste } from "@/lib/branding/contraste";
import {
  APARENCIA_PADRAO,
  ENVIADAS,
  RECEBIDAS,
  aparenciaSchema,
  estiloDaAparencia,
  lerAparencia,
} from "./aparencia-da-conversa";

const HEX = /^#[0-9a-f]{6}$/i;
/** O texto "apagado" (hora, rótulo) do balão do cliente é o `--color-text-muted` de cada tema. */
const MUTED = { claro: "#525252", escuro: "#b5b09f" } as const;

describe("aparência da conversa — contraste", () => {
  for (const [nome, p] of Object.entries({ ...ENVIADAS, ...RECEBIDAS })) {
    for (const tema of ["claro", "escuro"] as const) {
      const { fundo, texto } = p[tema];
      if (!HEX.test(fundo)) continue; // token da marca/tema: quem mede é a régua do branding
      it(`${nome} (${tema}): texto ≥ 4.5:1`, () => {
        expect(razaoDeContraste(fundo, texto)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  for (const [nome, p] of Object.entries(RECEBIDAS)) {
    for (const tema of ["claro", "escuro"] as const) {
      if (!HEX.test(p[tema].fundo)) continue;
      it(`${nome} (${tema}): hora e rótulo em texto apagado ≥ 4.5:1`, () => {
        expect(razaoDeContraste(p[tema].fundo, MUTED[tema])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("o texto apagado medido acima é o do globals.css (senão a régua mede a cor errada)", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(new RegExp(`--color-text-muted:\\s*${MUTED.claro}`));
    expect(css).toMatch(new RegExp(`--color-text-muted:\\s*${MUTED.escuro}`));
  });
});

describe("aparência da conversa — leitura do metadado (gravável pelo usuário)", () => {
  it("sem nada gravado, é o desenho de antes", () => {
    expect(lerAparencia(undefined)).toEqual(APARENCIA_PADRAO);
    expect(lerAparencia("lixo")).toEqual(APARENCIA_PADRAO);
  });

  it("um campo ruim não apaga os bons", () => {
    expect(lerAparencia({ fundo: "tom", enviada: "url(javascript:1)", recebida: "creme" })).toEqual({
      fundo: "tom",
      enviada: "marca",
      recebida: "creme",
    });
  });

  it("chave herdada do protótipo não passa por identificador", () => {
    expect(lerAparencia({ fundo: "toString", enviada: "constructor", recebida: "__proto__" })).toEqual(
      APARENCIA_PADRAO,
    );
  });

  it("a gravação recusa identificador desconhecido e campo a mais", () => {
    expect(aparenciaSchema.safeParse({ ...APARENCIA_PADRAO, enviada: "#ff0000" }).success).toBe(false);
    expect(aparenciaSchema.safeParse({ ...APARENCIA_PADRAO, extra: 1 }).success).toBe(false);
    expect(aparenciaSchema.safeParse({ fundo: "pontilhado", enviada: "azul", recebida: "cinza" }).success).toBe(
      true,
    );
  });

  it("o estilo traz as duas versões de cada cor — quem escolhe o tema é o CSS", () => {
    const estilo = estiloDaAparencia({ fundo: "tom", enviada: "azul", recebida: "creme" }) as Record<string, string>;
    expect(estilo["--bolha-enviada-fundo-claro"]).toBe(ENVIADAS.azul.claro.fundo);
    expect(estilo["--bolha-enviada-fundo-escuro"]).toBe(ENVIADAS.azul.escuro.fundo);
    expect(estilo["--bolha-recebida-texto-escuro"]).toBe(RECEBIDAS.creme.escuro.texto);
  });
});
