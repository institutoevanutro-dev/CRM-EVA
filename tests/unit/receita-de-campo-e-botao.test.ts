import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * D1.8 — uma receita para campo e botão. Antes, um campo bege de 40 px com
 * canto de 4 px ficava ao lado de um seletor transparente de 36 px com canto
 * de 8 px, e a borda dos dois sumia no branco (1,31:1).
 */
const RAIZ = process.cwd();
const ler = (f: string) => fs.readFileSync(path.join(RAIZ, f), "utf8");

describe("D1.8 — campo e botão com a mesma receita", () => {
  it.each(["input", "select", "textarea"])("%s usa a borda de campo, a superfície e o foco comuns", (nome) => {
    const fonte = ler(`components/ui/${nome}.tsx`);
    expect(fonte).toMatch(/rounded-md border border-border-input bg-surface/);
    expect(fonte).toMatch(/focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-500\/30/);
  });

  it("campo, seletor e botão padrão têm 40 px no mouse e 44 px no toque", () => {
    expect(ler("components/ui/input.tsx")).toMatch(/h-10 toque:h-11/);
    expect(ler("components/ui/select.tsx")).toMatch(/h-10 toque:h-11/);
    // Botão: 44 px abaixo de `lg` (tela estreita = celular, com ou sem toque).
    expect(ler("components/ui/button.tsx")).toMatch(/default: "h-11 lg:h-10 toque:h-11/);
  });

  it("a variante `toque` e o token de borda de campo existem", () => {
    const css = ler("app/globals.css");
    expect(css).toMatch(/^@custom-variant toque \(@media \(pointer: coarse\)\);/m);
    // :root, [data-theme="light"], [data-theme="dark"] e a ponte do @theme inline.
    expect(css.match(/^\s*--color-border-input:/gm)?.length).toBe(4);
  });
});
