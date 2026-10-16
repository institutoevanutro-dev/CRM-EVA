import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * EMBED ENTRE `ai_agents` E `ai_agent_versions` NOMEIA A CHAVE ESTRANGEIRA.
 *
 * As duas tabelas se ligam por DUAS chaves: `ai_agent_versions.agent_id` (as
 * versões do agente) e `ai_agents.published_version_id` (a versão no ar). Um
 * embed sem o nome da chave (`ai_agent_versions!inner(...)`) é ambíguo, e o
 * PostgREST recusa a consulta inteira com PGRST201 — sem erro na tela, porque o
 * chamador lia só `data`, que vinha `null`.
 *
 * Foi exatamente isso na tela "O que o agente sabe": a lista de quem consulta
 * cada material saía vazia, e todo cartão dizia "nenhum assistente ainda" numa
 * clínica com 98 buscas no acervo em 30 dias, feitas por 5 assistentes.
 *
 * Varre o AST: só texto que é string no código conta (comentário não).
 */
const RAIZ = join(__dirname, "..", "..");
const AREAS = ["app", "lib", "components", "hooks", "workers"];
// Só na POSIÇÃO de embed de um `select` do PostgREST: começo do texto, depois de
// vírgula, de parêntese ou de apelido (`versao:`). SQL cru (`insert into
// public.ai_agents (`) não é embed e não conta.
const EMBED = /(?<=(?:^|[,(:])\s*)(ai_agent_versions|ai_agents)((?:\s*!\s*\w+)*)\s*\(/g;

function arquivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(caminho);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [caminho] : [];
  });
}

function textosDoArquivo(caminho: string): string[] {
  const fonte = ts.createSourceFile(caminho, readFileSync(caminho, "utf8"), ts.ScriptTarget.Latest, true);
  const textos: string[] = [];
  const visitar = (no: ts.Node) => {
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) textos.push(no.text);
    else if (ts.isTemplateExpression(no)) {
      textos.push([no.head.text, ...no.templateSpans.map((s) => s.literal.text)].join(" "));
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return textos;
}

/** Os embeds sem `!<chave>_fkey` encontrados num texto. */
export function embedsAmbiguos(texto: string): string[] {
  return [...texto.matchAll(EMBED)]
    .filter(([, , modificadores]) => !/!\s*\w+_fkey\b/.test(modificadores ?? ""))
    .map(([trecho]) => trecho.trim());
}

describe("embed entre ai_agents e ai_agent_versions", () => {
  it("o detector pega a forma que quebrou e aceita a que nomeia a chave", () => {
    expect(embedsAmbiguos("id, name, ai_agent_versions!inner(id, knowledge_source_ids)")).toEqual([
      "ai_agent_versions!inner(",
    ]);
    expect(embedsAmbiguos("versao:ai_agent_versions!ai_agents_published_version_id_fkey(provider)")).toEqual([]);
    expect(embedsAmbiguos("ai_agents!ai_agent_versions_agent_id_fkey!inner(id, name)")).toEqual([]);
    expect(embedsAmbiguos("ai_agents(id, name)")).toEqual(["ai_agents("]);
    expect(embedsAmbiguos("insert into public.ai_agents (organization_id, name)")).toEqual([]);
  });

  it("nenhuma consulta do produto embute uma tabela na outra sem nomear a chave", () => {
    const achados = AREAS.flatMap((area) =>
      arquivos(join(RAIZ, area)).flatMap((caminho) =>
        textosDoArquivo(caminho).flatMap((texto) =>
          embedsAmbiguos(texto).map((embed) => `${relative(RAIZ, caminho)}: ${embed}`),
        ),
      ),
    );
    expect(achados, "use ai_agent_versions!ai_agents_published_version_id_fkey(...) ou !ai_agent_versions_agent_id_fkey").toEqual([]);
  });
});
