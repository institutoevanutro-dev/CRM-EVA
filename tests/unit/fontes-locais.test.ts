import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// `next/font/google` baixa as fontes DURANTE o `next build`; rede piscando
// derrubava build-and-size e imagens-ok. As fontes são locais (app/fonts/).
describe("fontes locais", () => {
  const usos = execSync("git grep -l next/font/ -- '*.ts' '*.tsx' ':!tests'", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  it("nenhum código usa next/font/google", () => {
    for (const f of usos) expect(readFileSync(f, "utf8"), f).not.toContain("next/font/google");
  });

  it("todo woff2 referenciado existe e tem a licença ao lado", () => {
    for (const f of usos) {
      const refs = [...readFileSync(f, "utf8").matchAll(/"([^"]+\.woff2)"/g)].map((m) => m[1]!);
      expect(refs.length, f).toBeGreaterThan(0);
      for (const r of refs) expect(existsSync(path.join(path.dirname(f), r)), `${f} → ${r}`).toBe(true);
    }
    expect(existsSync("app/fonts/README.md")).toBe(true);
    expect(execSync("ls app/fonts", { encoding: "utf8" })).toMatch(/\.OFL\.txt/);
  });
});
