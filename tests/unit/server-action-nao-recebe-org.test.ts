import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Todo export de um arquivo "use server" vira uma rota POST que qualquer um
 * alcança com o ID da ação (que vai dentro da imagem publicada). Um parâmetro
 * `orgId` ali é organização escolhida por quem chama: `dadosDoPasso(orgId)` abria
 * o funil e a chave de IA de qualquer organização. A org sai da sessão.
 *
 * Exceção: `setActiveOrg` recebe a org de propósito e confere a membership antes
 * de usá-la.
 */
const PERMITIDAS = new Set(["app/actions/shell/setActiveOrg.ts::setActiveOrg"]);
const PARAM_DE_ESCOPO = /\b(orgId|organizationId|organization_id|tenantId)\b/;

describe("server action não recebe a organização de quem chama", () => {
  it("nenhum export de arquivo \"use server\" tem parâmetro de organização", () => {
    const arquivos = globSync("{app,lib,components}/**/*.{ts,tsx}");
    const achados: string[] = [];
    for (const f of arquivos) {
      const s = readFileSync(f, "utf8");
      if (!/^\s*["']use server["']/m.test(s.slice(0, 2000))) continue;
      for (const m of s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) {
        const chave = `${f}::${m[1]}`;
        if (PARAM_DE_ESCOPO.test(m[2] ?? "") && !PERMITIDAS.has(chave)) achados.push(chave);
      }
    }
    expect(arquivos.length).toBeGreaterThan(100);
    expect(achados).toEqual([]);
  });
});
