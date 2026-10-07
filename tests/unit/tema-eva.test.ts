import { readFileSync } from "node:fs";
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
});
