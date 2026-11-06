import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * D1.11 — modo escuro legível: texto de apoio e texto sobre o vermelho com
 * pelo menos 4,5:1, borda de campo com pelo menos 3:1. Mede os hex dos blocos
 * de tema, então trocar uma cor por outra mais apagada reprova aqui.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function bloco(seletor: string): string {
  const i = CSS.indexOf(`\n${seletor} {`);
  if (i < 0) throw new Error(`sem bloco ${seletor}`);
  return CSS.slice(i, CSS.indexOf("\n}", i));
}
function hex(texto: string, token: string): string {
  const m = texto.match(new RegExp(`^\\s*${token}:\\s*(#[0-9a-f]{6});`, "im"));
  if (!m?.[1]) throw new Error(`${token} sem hex`);
  return m[1];
}
function luminancia(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe("D1.11 — modo escuro legível", () => {
  const escuro = bloco('[data-theme="dark"]');

  it("texto de apoio tem 4,5:1 na superfície elevada", () => {
    expect(contraste(hex(escuro, "--color-text-subtle"), hex(escuro, "--color-surface-elevated"))).toBeGreaterThanOrEqual(4.5);
  });

  it("texto sobre o vermelho (botão de excluir, contador do sino) tem 4,5:1", () => {
    for (const b of [":root", '[data-theme="light"]', '[data-theme="dark"]']) {
      const t = bloco(b);
      expect(contraste(hex(t, "--color-on-error"), hex(t, "--color-error")), b).toBeGreaterThanOrEqual(4.5);
    }
    expect(CSS).toMatch(/^\s*--destructive-foreground: var\(--color-on-error\);/m);
  });

  it("borda de campo tem 3:1 na superfície", () => {
    for (const b of [":root", '[data-theme="dark"]']) {
      const t = bloco(b);
      expect(contraste(hex(t, "--color-border-input"), hex(t, "--color-surface")), b).toBeGreaterThanOrEqual(3);
    }
  });
});
