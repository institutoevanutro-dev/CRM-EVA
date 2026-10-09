import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * COR DA PALETA DO TAILWIND SÓ COM O PAR DO MODO ESCURO.
 *
 * `bg-amber-100 text-amber-900` é desenhado para o fundo claro: no modo escuro
 * vira uma faixa clara com texto escuro no meio da tela escura. As cores de
 * aviso, erro, sucesso e informação têm tokens que mudam com o tema
 * (`bg-warning-bg`, `text-error-fg`, `border-info/30`...), e é eles que se usa.
 *
 * Linha que traz `dark:` já foi desenhada para os dois temas e passa.
 * `neutral-*` é token do tema (redefinido em `[data-theme="dark"]`) e passa.
 */

const PALETA =
  /(?<![\w:-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide)-(?:(?:gray|slate|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white(?![\w/-]))/g;

/** Fundo branco de propósito: QR code e prévia de logo precisam do branco nos dois temas. */
const FUNDO_BRANCO_DE_PROPOSITO = new Set([
  "app/onboarding/connect-whatsapp/_client.tsx",
  "components/auth/MfaEnrollModal.tsx",
  "components/branding/CampoDeLogo.tsx",
  "components/connections/CanalVozClient.tsx",
  "components/connections/ConnectionsClient.tsx",
]);

describe("cores fixas e o modo escuro", () => {
  it("nenhuma cor da paleta sem o par dark: nas telas", () => {
    const arquivos = execSync("git ls-files app components hooks", { encoding: "utf8" })
      .split("\n")
      .filter((a) => a.endsWith(".tsx") && !a.includes(".test.") && !a.startsWith("app/design/"));
    const achados: string[] = [];
    for (const a of arquivos) {
      readFileSync(a, "utf8")
        .split("\n")
        .forEach((linha, i) => {
          if (linha.includes("dark:") || /^\s*(\/\/|\*|\/\*)/.test(linha)) return;
          for (const m of linha.match(PALETA) ?? []) {
            if (/^text-white$/.test(m)) continue;
            if (m === "bg-white" && FUNDO_BRANCO_DE_PROPOSITO.has(a)) continue;
            achados.push(`${a}:${i + 1} ${m}`);
          }
        });
    }
    expect(achados).toEqual([]);
  });
});
