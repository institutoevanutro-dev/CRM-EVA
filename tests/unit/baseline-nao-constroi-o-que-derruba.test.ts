import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O BASELINE NÃO CONSTRÓI UM ÍNDICE PARA O PRÓPRIO APÊNDICE DERRUBAR.
 *
 * O `baseline.sql` é aplicado inteiro em toda instalação e em todo `update.sh`.
 * Um índice criado no corpo (ou num bloco antigo do apêndice) e derrubado num
 * bloco posterior é construído e jogado fora TODA vez — `CREATE INDEX` não
 * concorrente, que trava escrita na tabela enquanto constrói. Numa tabela
 * pequena são milissegundos; numa instalação com histórico é lock e tempo em
 * cada atualização, pago por ninguém.
 *
 * Foi o que a migration 0259 trouxe na primeira versão: os três índices
 * redundantes seguiam criados acima (linha do dump, bloco da 0127, bloco do
 * calendário) e o apêndice os derrubava no fim. Medido em pg17, aplicando o
 * baseline até o rótulo da 0259: os três existiam naquele ponto.
 *
 * A regra: o índice que o arquivo derruba e não recria depois não pode ter um
 * `create … index … X` antes do drop — a não ser dentro de um bloco `do`
 * (condicional por construção neste arquivo), ou na lista de dívida abaixo, que
 * só encolhe. Drop seguido de nova criação é redefinição e fica fora.
 *
 * Lê texto; que o ciclo install→update sai 0 é o job `invariants` quem mede, e
 * `tests/invariants/indices-redundantes-saem.test.ts` mede o estado final.
 */
const SQL = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

/**
 * Pares que já existiam antes deste teste, de outra migration, fora do escopo do
 * conserto que o criou. SÓ ENCOLHE: consertar um é tirá-lo daqui.
 */
// Zerada: os dois índices únicos da 0181 (`ai_kbv_one_active_per_agent` e
// `ai_knowledge_sources_unique_per_agent`) saíram do dump; o apêndice segue
// derrubando-os em clone antigo.
const DIVIDA_ANTERIOR: string[] = [];

interface Par {
  nome: string;
  linhaDaCriacao: number;
  linhaDoDrop: number;
  condicional: boolean;
}

function linhaDe(pos: number): number {
  return SQL.slice(0, pos).split("\n").length;
}

/** A posição está dentro de um `do $x$ … end $x$;` aberto e ainda não fechado? */
function dentroDeBlocoDo(pos: number): boolean {
  const antes = SQL.slice(0, pos);
  const aberturas = [...antes.matchAll(/^\s*do\s+\$([a-z_]*)\$/gim)];
  const ultima = aberturas.at(-1);
  if (!ultima || ultima.index === undefined) return false;
  const marca = `$${ultima[1]}$`;
  const trecho = antes.slice(ultima.index + ultima[0].length);
  return !trecho.toLowerCase().includes(`end ${marca.toLowerCase()}`);
}

/**
 * Pares cria→derruba cujo índice NÃO sobrevive ao arquivo. `drop` seguido de
 * nova criação do mesmo nome é REDEFINIÇÃO (trocar predicado de índice parcial
 * só se faz assim) e o índice termina de pé — fica fora, é outra regra.
 */
function paresCriaDerruba(): Par[] {
  const drops = new Map<string, number>();
  for (const d of SQL.matchAll(/drop index (?:concurrently )?if exists (?:"?public"?\.)?"?([a-z0-9_]+)"?/gi)) {
    drops.set(d[1]!.toLowerCase(), d.index!); // o ÚLTIMO drop de cada nome
  }
  const pares: Par[] = [];
  for (const [nome, posDrop] of drops) {
    const criacoes = [
      ...SQL.matchAll(
        new RegExp(`create (?:unique )?index (?:concurrently )?(?:if not exists )?"?${nome}"?(?=\\s|$)`, "gi"),
      ),
    ].map((c) => c.index!);
    if (criacoes.some((pos) => pos > posDrop)) continue; // redefinido: termina de pé
    for (const pos of criacoes) {
      pares.push({
        nome,
        linhaDaCriacao: linhaDe(pos),
        linhaDoDrop: linhaDe(posDrop),
        condicional: dentroDeBlocoDo(pos),
      });
    }
  }
  return pares;
}

describe("baseline.sql não constrói índice que ele mesmo derruba", () => {
  it("o instrumento está vivo: acha drops, e acha a dívida conhecida", () => {
    // Controle positivo. Um regex que parasse de casar devolveria lista vazia, e
    // "nenhum par proibido" ficaria verde vigiando nada.
    const pares = paresCriaDerruba();
    expect(pares.length, "nenhum par cria→derruba encontrado — o parser mudou?").toBeGreaterThan(0);
    for (const nome of DIVIDA_ANTERIOR) {
      expect(
        pares.some((p) => p.nome === nome),
        `"${nome}" saiu da dívida: tire-o de DIVIDA_ANTERIOR`,
      ).toBe(true);
    }
  });

  it("nenhuma criação incondicional antes do drop, fora da dívida anterior", () => {
    const proibidos = paresCriaDerruba()
      .filter((p) => !p.condicional && !DIVIDA_ANTERIOR.includes(p.nome))
      .map((p) => `${p.nome}: criado na linha ${p.linhaDaCriacao}, derrubado na ${p.linhaDoDrop}`);
    expect(
      proibidos,
      "Índice construído e jogado fora a cada install/update. Tire a criação (ou a torne " +
        "condicional ao mesmo predicado do drop, invertido).\n",
    ).toEqual([]);
  });

  it("a criação condicional de ai_models_provider_model_unique depende da AUSÊNCIA da constraint", () => {
    // O bloco `do` sozinho não prova nada: um `if true then create …` passaria no
    // caso acima. O que torna a criação inofensiva é o predicado ser o inverso do
    // guard do drop da 0259 — os dois nunca agem sobre o mesmo banco.
    const par = paresCriaDerruba().find((p) => p.nome === "ai_models_provider_model_unique");
    expect(par, "a criação da 0127 sumiu — confira se a unicidade ainda tem fallback").toBeDefined();
    const linhas = SQL.split("\n");
    const janela = linhas.slice(Math.max(0, par!.linhaDaCriacao - 8), par!.linhaDaCriacao).join("\n");
    expect(janela).toMatch(/if not exists \(\s*select 1 from pg_constraint\s+where conname = 'ai_models_unique'/);
  });
});
