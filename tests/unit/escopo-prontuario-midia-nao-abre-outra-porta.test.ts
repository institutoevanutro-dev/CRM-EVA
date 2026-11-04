import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hasMcpToolScope } from "@/lib/mcp/agenda-scope";
import { ensureMcpToolScope, ensureScope, McpAuthError } from "@/lib/mcp/auth";
import { allTools } from "@/lib/mcp/tools";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * A CHAVE `prontuario:media:read` NÃO ABRE OUTRA PORTA (molde:
 * `escopo-financeiro-contatos-nao-abre-outra-porta.test.ts`).
 *
 * O escopo deixa o Prontuário listar e baixar PDF e fotos do WhatsApp — e só
 * isso. O texto só pode aparecer nas duas rotas de mídia, na régua
 * `authorizeProntuario` e no catálogo da tela de chaves; e nenhuma ferramenta
 * MCP o aceita, nem pela exceção da agenda (`hasMcpToolScope`, a única régua
 * que aceita escopo diferente do pedido). Qualquer outra régua que passasse a
 * aceitá-lo teria de escrevê-lo, e reprova aqui.
 */
const ESCOPO = "prontuario:media:read";

const ONDE_PODE_APARECER = [
  "app/api/v1/prontuario/contacts/[id]/midias/route.ts",
  "app/api/v1/prontuario/midias/[id]/route.ts",
  "lib/prontuario/contacts.ts",
  "app/app/settings/api-tokens/_components/ApiTokensClient.tsx",
].sort();

describe("o escopo de mídia do Prontuário não abre outra porta", () => {
  it("só as duas rotas, a régua do Prontuário e a tela de chaves escrevem o escopo", () => {
    const arquivos = arquivosDeCodigo(["app", "components", "hooks", "lib", "workers"]);
    // Controle positivo: varredura que não acha nada não olhou.
    expect(arquivos.length).toBeGreaterThan(1000);
    const onde = arquivos
      .filter((a) => readFileSync(a, "utf8").includes(ESCOPO))
      .map(caminhoRelativo)
      .sort();
    expect(onde).toEqual(ONDE_PODE_APARECER);
  });

  it("nenhuma ferramenta MCP aceita a chave, nem pela exceção da agenda", () => {
    // Controle positivo: o catálogo foi carregado e a régua aceita quem deve.
    expect(allTools.length).toBeGreaterThan(10);
    const leitura = allTools.find((t) => t.requiresScope === "mcp:read");
    expect(leitura && hasMcpToolScope(["mcp:read"], leitura.name, "mcp:read")).toBe(true);

    const abertas = allTools.filter((t) => hasMcpToolScope([ESCOPO], t.name, t.requiresScope)).map((t) => t.name);
    expect(abertas).toEqual([]);

    for (const t of allTools) {
      expect(() => ensureMcpToolScope([ESCOPO], t.name, t.requiresScope)).toThrow(McpAuthError);
    }
  });

  it("a régua comum não confunde o escopo com mcp:read nem com mcp:write", () => {
    for (const exigido of ["mcp:read", "mcp:write", "contacts:read", "prontuario:contacts:read", "financeiro:contatos"]) {
      let erro: unknown;
      try {
        ensureScope([ESCOPO], exigido);
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(McpAuthError);
      expect((erro as McpAuthError).httpStatus).toBe(403);
    }
  });
});
