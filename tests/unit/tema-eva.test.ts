import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Cores medidas no Eva Financeiro (~/eva-financeiro/app/globals.css). Spec:
// docs/superpowers/specs/2026-10-07-cores-e-menu-design.md
const css = readFileSync("app/globals.css", "utf8");
const bloco = (seletor: string) => {
  const i = css.indexOf(`\n${seletor} {`);
  expect(i, `bloco ${seletor} não existe`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("\n}", i + 1));
};
const valor = (b: string, token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(b)?.[1]?.trim();

describe("cores iguais às do Financeiro", () => {
  it("tema claro: creme, borda bege", () => {
    for (const seletor of [":root", '[data-theme="light"]']) {
      const b = bloco(seletor);
      expect(valor(b, "--color-bg")).toBe("#f7f4ec");
      expect(valor(b, "--color-border")).toBe("#e6e1d3");
    }
  });
  it("menu verde com dourado", () => {
    const raiz = bloco(":root");
    expect(valor(raiz, "--color-sidebar-bg")).toBe("#1d352c");
    expect(valor(raiz, "--color-sidebar-fg")).toBe("#e9e2c8");
    expect(valor(raiz, "--color-gold")).toBe("#d9b24c");
  });
  it("tema escuro é verde fechado, não cinza", () => {
    const b = bloco('[data-theme="dark"]');
    expect(valor(b, "--color-bg")).toBe("#0f1d18");
    expect(valor(b, "--color-surface")).toBe("#152820");
    expect(valor(b, "--color-sidebar-bg")).toBe("#0b1612");
  });
  it("tokens do menu viram utilitários", () => {
    const ponte = css.slice(css.indexOf("@theme inline {"));
    expect(ponte).toMatch(/--color-sidebar:\s*var\(--color-sidebar-bg\)/);
    expect(ponte).toMatch(/--color-gold:\s*var\(--color-gold\)/);
  });
  it("fontes do contrato visual comum (D1.13): Inter no texto, Lora nos títulos, Josefin nas seções", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    expect(layout).toMatch(/import localFont from "next\/font\/local"/);
    for (const arq of ["inter", "lora", "josefin-sans", "inconsolata"]) {
      expect(layout).toContain(`"./fonts/${arq}.woff2"`);
      expect(existsSync(`app/fonts/${arq}.woff2`), arq).toBe(true);
    }
    expect(layout).not.toMatch(/cormorant|atkinson/i);
    expect(css).toMatch(/--font-sans:\s*var\(--font-inter\)/);
    expect(css).toMatch(/--font-titulo:\s*var\(--font-lora\)/);
    expect(css).toMatch(/--font-secao:\s*var\(--font-josefin\)/);
    expect(css).not.toMatch(/--font-(cormorant|atkinson)/);
  });
});

describe("telas do tamanho da janela descontam as abas da área", () => {
  it("toda tela do tamanho da janela desconta --altura-das-abas", () => {
    for (const arquivo of ["components/inbox/InboxLayout.tsx", "app/app/pipelines/[id]/_client.tsx"]) {
      const alturas = readFileSync(arquivo, "utf8").match(/h-\[calc\(100dvh[^\]]*\)\]/g) ?? [];
      expect(alturas.length, arquivo).toBeGreaterThan(0);
      for (const a of alturas) expect(a, arquivo).toContain("var(--altura-das-abas,0px)");
    }
  });
});
