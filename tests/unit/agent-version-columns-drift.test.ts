/**
 * A lista de colunas de `ai_agent_versions` está copiada em 7 arquivos (as rotas
 * REST, a server action e a página do agente). Adicionar uma coluna nova em
 * apenas alguns deles não quebra typecheck nem teste nenhum — o sintoma aparece
 * só na tela, como um campo que "se desmarca sozinho" depois do refresh, e o
 * save seguinte grava o valor errado por cima.
 *
 * Foi exatamente o que aconteceu com `cases_enabled` (spec 15, Wave 5): entrou
 * em 2 dos 7 arquivos. Este teste trava a divergência de qualquer coluna futura,
 * não só dessa — enquanto as cópias existirem, elas têm que ser idênticas.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { versionCreateSchema } from "@/lib/ai/agents/validation";

const ROOT = process.cwd();

/** Todo arquivo que carrega uma cópia da lista de colunas de versão. */
const FILES_WITH_VERSION_COLUMNS = [
  "app/app/ai/agents/[id]/_actions.ts",
  "app/app/ai/agents/[id]/page.tsx",
  "app/api/v1/ai/agents/route.ts",
  "app/api/v1/ai/agents/[id]/versions/route.ts",
  "app/api/v1/ai/agents/[id]/versions/[vid]/route.ts",
  // A cópia da rota /duplicate mudou de casa: a implementação agora é
  // compartilhada com o botão "Duplicar" da lista, em lib/ai/agents/duplicate.ts.
  // O arquivo vigiado é onde a lista mora, não onde ela morava.
  "lib/ai/agents/duplicate.ts",
];

/** Extrai o conteúdo da string atribuída a VERSION_COLUMNS. */
function versionColumnsOf(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const match = /VERSION_COLUMNS\s*(?::\s*string)?\s*=\s*\n?\s*"([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error(`VERSION_COLUMNS não encontrado em ${relPath}`);
  }
  return (match[1] ?? "").split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

describe("VERSION_COLUMNS de ai_agent_versions", () => {
  it("é idêntico em todos os arquivos que o copiam", () => {
    const [firstFile, ...restFiles] = FILES_WITH_VERSION_COLUMNS;
    if (firstFile === undefined) throw new Error("lista de arquivos vazia");
    const expected = versionColumnsOf(firstFile);
    expect(expected.length).toBeGreaterThan(10);

    for (const file of restFiles) {
      const columns = versionColumnsOf(file);
      // Compara como conjunto ordenado: ordem no SELECT não importa, presença sim.
      expect({ file, columns: [...columns].sort() }).toEqual({
        file,
        columns: [...expected].sort(),
      });
    }
  });

  it("inclui as flags por-agente que a tela edita", () => {
    // Regressão direta do bug do cases_enabled: uma flag que a tela grava mas o
    // SELECT não devolve volta como `false` no próximo render.
    for (const file of FILES_WITH_VERSION_COLUMNS) {
      const columns = versionColumnsOf(file);
      expect(columns).toContain("handoff_tool_enabled");
      expect(columns).toContain("cases_enabled");
      expect(columns).toContain("split_messages");
      expect(columns).toContain("split_max_chars");
    }
  });
});

/**
 * O SELECT idêntico não basta: o payload do form passa por `versionCreateSchema`,
 * que é `.strict()`. Coluna ausente do schema faz o parse REJEITAR o save inteiro
 * (ou, se fosse não-strict, silenciosamente descartar o campo). Foi o segundo elo
 * quebrado do split de mensagens: a coluna existia no banco e no runtime, mas o
 * schema não a conhecia, então a tela nunca conseguiria gravá-la.
 */
describe("versionCreateSchema aceita as flags por-agente que a tela edita", () => {
  const base = {
    system_prompt: "Você é um atendente de testes.",
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    credential_id: "11111111-1111-4111-8111-111111111111",
    channel_session_id: "22222222-2222-4222-8222-222222222222",
  };

  it("preserva split_messages/split_max_chars no parse", () => {
    const parsed = versionCreateSchema.safeParse({
      ...base,
      split_messages: true,
      split_max_chars: 240,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.split_messages).toBe(true);
    expect(parsed.success && parsed.data.split_max_chars).toBe(240);
  });

  it("cai nos defaults da migration 0059 quando omitido", () => {
    const parsed = versionCreateSchema.safeParse(base);
    expect(parsed.success && parsed.data.split_messages).toBe(false);
    expect(parsed.success && parsed.data.split_max_chars).toBe(600);
  });
});

/**
 * O SELECT e o schema iguais ainda não bastam: cada caminho que grava uma versão
 * monta o INSERT campo a campo. `followup` ficou fora do reverter e do criar
 * assistente pela tela, e o INSERT de `lib/ai/apply-proposal.ts` ficou fora da
 * cerca inteira (a lista de arquivos era escrita à mão) e devolvia ao default do
 * banco nove chaves de `versionShapeSchema` em toda proposta aplicada.
 *
 * Por isso ESTE BLOCO NÃO TEM LISTA DE ARQUIVOS: os caminhos são descobertos
 * varrendo `app/` e `lib/`, e as chaves cobradas saem do próprio
 * `versionShapeSchema`. Arquivo novo que grave versão entra na cerca sozinho;
 * coluna nova no schema passa a ser cobrada sem editar este arquivo.
 *
 * Portado de melgarafael/DeskcommCRM 102d34e12 e 07c5fe78b (autor: webtecnica),
 * sem o caminho de spread do schema estrito: neste fork todo INSERT de versão é
 * objeto literal.
 */
const RAIZES_DE_CODIGO = ["app", "lib"] as const;
const INSERT_SUPABASE = /\.from\("ai_agent_versions"\)\s*\.insert\(/;
const INSERT_SQL = /insert\s+into\s+ai_agent_versions\s*\(/i;

type Fonte = { rel: string; source: string };
let cacheDeFontes: Fonte[] | null = null;

function fontesDeCodigo(): Fonte[] {
  if (cacheDeFontes !== null) return cacheDeFontes;
  const fontes: Fonte[] = [];
  const andar = (dir: string): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const absoluto = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name !== "node_modules" && entrada.name !== ".next") andar(absoluto);
        continue;
      }
      if (!/\.tsx?$/.test(entrada.name)) continue;
      if (/\.test\.tsx?$/.test(entrada.name) || entrada.name.endsWith(".d.ts")) continue;
      fontes.push({ rel: relative(ROOT, absoluto), source: readFileSync(absoluto, "utf8") });
    }
  };
  for (const raiz of RAIZES_DE_CODIGO) andar(join(ROOT, raiz));
  cacheDeFontes = fontes;
  return fontes;
}

function fonte(rel: string): string {
  const achada = fontesDeCodigo().find((f) => f.rel === rel);
  if (!achada) throw new Error(`${rel} não está em app/ nem em lib/`);
  return achada.source;
}

/** Texto entre as chaves que abrem em `inicio` (índice do `{`). */
function corpoDeChaves(source: string, inicio: number): string {
  let nivel = 1;
  let i = inicio + 1;
  for (; i < source.length && nivel > 0; i++) {
    if (source[i] === "{") nivel++;
    else if (source[i] === "}") nivel--;
  }
  return source.slice(inicio, i);
}

function corpoDaFuncao(source: string, nome: string): string {
  const abertura = new RegExp(`function\\s+${nome}\\s*\\([^)]*\\)[^{]*\\{`).exec(source);
  if (!abertura) throw new Error(`corpo da função ${nome} não encontrado`);
  return corpoDeChaves(source, abertura.index + abertura[0].length - 1);
}

function arquivosQueGravamVersao(): string[] {
  return fontesDeCodigo()
    .filter((f) => INSERT_SUPABASE.test(f.source) || INSERT_SQL.test(f.source))
    .map((f) => f.rel)
    .sort();
}

/** A única lista à mão, com o motivo de cada arquivo. */
const INSERTS_FORA_DA_COBRANCA: Record<string, string> = {
  "lib/ai/agents/first-publication.ts":
    "Cria a v1 do zero (onboarding e reconciliação de instalação legada): não existe " +
    "versão de origem de onde copiar, e o resto é default do banco, que é o que o " +
    "onboarding quer.",
};

/**
 * Alvo de cobrança de cada `.from("ai_agent_versions").insert({...})`: o próprio
 * objeto literal e, se ele espalha `versionPayloadFrom`, também o corpo do helper
 * (só a união das duas é o que a linha grava). Argumento que não é objeto literal
 * reprova: um caminho novo não passa em silêncio porque a cerca não sabe olhar.
 */
function sitesDeInsert(source: string): string[] {
  const alvos: string[] = [];
  const re = /\.from\("ai_agent_versions"\)\s*\.insert\(/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i] as string)) i++;
    if (source[i] !== "{") {
      throw new Error("INSERT de versão sem objeto literal: a cerca não sabe que chaves ele grava");
    }
    let alvo = source.slice(m.index, corpoDeChaves(source, i).length + i);
    if (alvo.includes("...versionPayloadFrom(")) {
      alvo += `\n${corpoDaFuncao(fonte("lib/ai/agents/duplicate.ts"), "versionPayloadFrom")}`;
    }
    alvos.push(alvo);
  }
  return alvos;
}

function chavesDeConteudoDaVersao(): string[] {
  return Object.keys(versionCreateSchema.shape);
}

/** Nomes de chave (`chave:` no início de linha) — um comentário que cite a palavra não conta. */
function chavesNomeadas(bloco: string): string[] {
  const nomes = new Set<string>();
  const re = /^\s+([a-z_][a-z0-9_]*):/gm;
  for (let m = re.exec(bloco); m !== null; m = re.exec(bloco)) {
    if (m[1] !== undefined) nomes.add(m[1]);
  }
  return [...nomes];
}

describe("todo INSERT de versão leva todas as chaves de versionShapeSchema", () => {
  it("o extrator acusa um INSERT sem uma chave do schema (controle positivo)", () => {
    const sem = `admin.from("ai_agent_versions").insert({\n  split_max_chars: 1,\n  followup: { a: 1 },\n})`;
    const alvos = sitesDeInsert(sem);
    expect(alvos).toHaveLength(1);
    const faltando = chavesDeConteudoDaVersao().filter(
      (c) => !chavesNomeadas(alvos[0] ?? "").includes(c),
    );
    expect(faltando).toContain("system_prompt");
    expect(faltando).not.toContain("split_max_chars");
  });

  it("descobre sozinho os arquivos que gravam versão", () => {
    const descobertos = arquivosQueGravamVersao();
    for (const esperado of [
      "app/api/v1/ai/agents/route.ts",
      "app/api/v1/ai/agents/[id]/versions/route.ts",
      "app/app/ai/agents/[id]/_actions.ts",
      "lib/ai/agents/duplicate.ts",
      "lib/ai/apply-proposal.ts",
      ...Object.keys(INSERTS_FORA_DA_COBRANCA),
    ]) {
      expect(descobertos, `${esperado} saiu da descoberta`).toContain(esperado);
    }
  });

  it("todos os caminhos descobertos levam todas as chaves", () => {
    const furos: Array<{ file: string; faltando: string[] }> = [];
    for (const file of arquivosQueGravamVersao()) {
      if (file in INSERTS_FORA_DA_COBRANCA) continue;
      const source = fonte(file);
      expect(
        INSERT_SQL.test(source),
        `${file} grava versão em SQL puro sem estar em INSERTS_FORA_DA_COBRANCA`,
      ).toBe(false);
      const alvos = sitesDeInsert(source);
      expect(alvos.length, `${file} grava versão e a cerca não achou o alvo`).toBeGreaterThan(0);
      for (const alvo of alvos) {
        const nomeadas = chavesNomeadas(alvo);
        const faltando = chavesDeConteudoDaVersao().filter((c) => !nomeadas.includes(c));
        if (faltando.length > 0) furos.push({ file, faltando });
      }
    }
    expect(furos).toEqual([]);
  });
});
