import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredTheme, STORAGE_KEY } from "@/lib/theme";

// Spec 2026-10-07-cores-e-menu: claro é o padrão (igual ao Eva Financeiro); o escuro
// continua para quem escolher, e a escolha salva vence o padrão novo.
afterEach(() => window.localStorage.clear());

describe("tema padrão", () => {
  it("sem escolha salva, é claro", () => {
    expect(readStoredTheme()).toBe("light");
  });
  it("quem escolheu escuro continua no escuro", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });
  it("o script anti-piscada não segue mais o sistema quando não há escolha", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    const script = /const THEME_INIT_SCRIPT = `([^`]+)`/.exec(layout)?.[1] ?? "";
    expect(script).toContain("deskcomm-theme");
    expect(script).not.toMatch(/!s\)&&d/);
  });
});
