import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hasMcpToolScope } from "@/lib/mcp/agenda-scope";
import { ensureMcpToolScope, ensureScope, McpAuthError } from "@/lib/mcp/auth";
import { allTools } from "@/lib/mcp/tools";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * A CHAVE `financeiro:contatos` NÃO ABRE OUTRA PORTA.
 *
 * O escopo existe para que a chave do Financeiro deixe de precisar de
 * `mcp:read`, que lê todas as conversas pelo MCP. Ele só vale alguma coisa se
 * nenhuma outra régua o aceitar. Toda régua de escopo do CRM compara texto
 * exato (`ensureScope`), com UMA exceção que aceita escopo diferente do pedido:
 * `hasMcpToolScope`, a da agenda. Por isso a prova tem duas partes:
 *
 *  1. o texto `financeiro:contatos` só aparece em código de produção na rota do
 *     Financeiro e no catálogo da tela de chaves. Qualquer outra régua que
 *     passasse a aceitá-lo teria de escrevê-lo, e reprova aqui;
 *  2. nenhuma ferramenta MCP aceita a chave, nem pela exceção da agenda.
 *
 * Os casos de rota (`/api/v1/contacts` e as de escrita por `resolveAuthDual`)
 * estão nos testes de cada uma.
 */
const ESCOPO = "financeiro:contatos";

const ONDE_PODE_APARECER = [
  "app/api/v1/integrations/financeiro/contacts/[id]/route.ts",
  "app/app/settings/api-tokens/_components/ApiTokensClient.tsx",
].sort();

describe("o escopo do Financeiro não abre outra porta", () => {
  it("só a rota do Financeiro e a tela de chaves escrevem o escopo", () => {
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
    for (const exigido of ["mcp:read", "mcp:write", "contacts:read", "prontuario:contacts:read"]) {
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
