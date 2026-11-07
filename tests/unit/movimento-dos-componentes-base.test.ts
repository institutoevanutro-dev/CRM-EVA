import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * D1.1 — movimento só onde mostra o que mudou.
 *
 * O Tailwind 4 descarta `animate-in`, `zoom-in-95` e `slide-in-from-*` sem
 * aviso (não há plugin de animação instalado). Os diálogos abriam em 0 ms e
 * os menus carregavam classes mortas que convidavam alguém a "consertar"
 * instalando um plugin — o que ligaria ~170 animações de uma vez nos
 * controles mais clicados da recepção.
 */
const RAIZ = process.cwd();
const ler = (f: string) => fs.readFileSync(path.join(RAIZ, f), "utf8");
const CSS = ler("app/globals.css");

describe("D1.1 — movimento dos componentes base", () => {
  it.each(["dialog", "alert-dialog", "sheet", "select", "dropdown-menu", "popover", "tooltip"])(
    "%s não usa classes de animação que o Tailwind 4 não gera",
    (nome) => {
      const fonte = ler(`components/ui/${nome}.tsx`);
      expect(fonte).not.toMatch(/\banimate-(?:in|out)\b|\b(?:zoom|fade)-(?:in|out)-\d|\bslide-(?:in|out)-/);
    },
  );

  it("diálogo, confirmação e gaveta usam os keyframes à mão, com véu do token", () => {
    expect(ler("components/ui/dialog.tsx")).toMatch(/bg-overlay anima-veu/);
    expect(ler("components/ui/dialog.tsx")).toMatch(/anima-dialogo/);
    expect(ler("components/ui/alert-dialog.tsx")).toMatch(/anima-dialogo/);
    expect(ler("components/ui/sheet.tsx")).toMatch(/bg-overlay\/60 anima-veu/);
    expect(ler("components/ui/sheet.tsx")).toMatch(/anima-gaveta/);
    for (const u of ["anima-veu", "anima-dialogo", "anima-gaveta"]) {
      expect(CSS).toMatch(new RegExp(`^@utility ${u} \\{`, "m"));
    }
    // Tempos do contrato: diálogo 200/150 ms, gaveta 300/200 ms.
    expect(CSS).toMatch(/eva-dialogo-entra 200ms/);
    expect(CSS).toMatch(/eva-dialogo-sai 150ms/);
    expect(CSS).toMatch(/eva-gaveta-entra 300ms/);
    expect(CSS).toMatch(/eva-gaveta-sai 200ms/);
  });

  it("tem a regra global de movimento reduzido, fora de @layer", () => {
    const i = CSS.lastIndexOf("@media (prefers-reduced-motion: reduce) {\n  *,");
    expect(i).toBeGreaterThan(0);
    // Nenhum `@layer` aberto antes dela que ainda não fechou: a regra está no
    // nível de topo (só os blocos de topo começam na coluna 0).
    const antes = CSS.slice(0, i);
    const abertos = (antes.match(/^@layer [a-z]+ \{/gm) ?? []).length;
    const fechados = (antes.match(/^\}/gm) ?? []).length;
    expect(fechados).toBeGreaterThanOrEqual(abertos);
    expect(CSS.slice(i, i + 300)).toMatch(/animation-duration: 0\.01ms !important/);
  });
});
