import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * D1.2 — campo com menos de 16 px faz o Safari do iPhone ampliar a página ao
 * focar. A correção é tamanho de fonte, nunca `maximum-scale`: esse bloqueia
 * o zoom de quem precisa dele para ler.
 */
const RAIZ = process.cwd();
const ler = (f: string) => fs.readFileSync(path.join(RAIZ, f), "utf8");

describe("D1.2 — campos não ampliam a tela no toque", () => {
  it("globals.css garante 16 px a todo campo de texto em tela de toque", () => {
    expect(ler("app/globals.css")).toMatch(
      /@media \(pointer: coarse\) \{\s*input:not\([^)]*\),\s*select,\s*textarea \{\s*font-size: max\(16px, 1rem\);/,
    );
  });

  it("Input e Textarea base nascem com 16 px e só descem a 14 px de md para cima", () => {
    expect(ler("components/ui/input.tsx")).toMatch(/text-base md:text-sm/);
    expect(ler("components/ui/textarea.tsx")).toMatch(/text-base md:text-sm/);
  });

  it("o viewport não bloqueia o zoom", () => {
    const layout = ler("app/layout.tsx");
    expect(layout).not.toMatch(/maximumScale|maximum-scale|userScalable|user-scalable/);
  });
});
