/**
 * D1.12: o <main> do AppShell é a ÚNICA margem das telas, e a barra do topo
 * fica mais baixa a partir de md. As duas medidas moram em variáveis do
 * AppShell, lidas também pelas contas de altura do Inbox e do funil.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const casca = readFileSync("app/app/_components/AppShell.tsx", "utf8");

function paginas(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return paginas(p);
    return /^(page|loading)\.tsx$/.test(n) ? [p] : [];
  });
}

describe("uma margem só", () => {
  it("a casca define a altura do topo e a margem, 56→48 px e 16→24 px", () => {
    expect(casca).toContain("[--altura-do-topo:3.5rem]");
    expect(casca).toContain("md:[--altura-do-topo:3rem]");
    expect(casca).toContain("[--margem-do-conteudo:var(--space-4)]");
    expect(casca).toContain("md:[--margem-do-conteudo:var(--space-6)]");
    expect(casca).toMatch(/<main id="conteudo" tabIndex=\{-1\} className="[^"]*p-\(--margem-do-conteudo\)/);
    expect(readFileSync("components/shell/TopBar.tsx", "utf8")).toContain("h-(--altura-do-topo,3.5rem)");
  });

  it("as contas de altura leem as variáveis, não 3.5rem nem p-6 somados à mão", () => {
    for (const f of ["components/inbox/InboxLayout.tsx", "app/app/pipelines/[id]/_client.tsx"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).toContain("-var(--altura-do-topo)-");
      expect(s, f).toContain("2*var(--margem-do-conteudo)");
      expect(s, f).not.toMatch(/100dvh-[^\]]*3\.5rem/);
    }
  });

  it("nenhuma página põe margem própria na raiz (p-6 ou md:p-8 logo após o return)", () => {
    const culpados = paginas("app/app").filter((f) =>
      /return \(\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<(?:div|main|section)[^>]*className="[^"]*(?:^|\s)(?:p-6|md:p-8)(?:\s|")/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(culpados).toEqual([]);
  });
});
