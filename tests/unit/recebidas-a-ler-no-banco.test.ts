/**
 * A LEITURA DO VISTO AZUL NA ORDEM DO BANCO — filtro antes do teto (porte de
 * melgarafael/DeskcommCRM#5047).
 *
 * O dublê compartilhado do handler devolve a leitura em lote sem casar filtro
 * nem teto, então ele não enxerga que o FILTRO VEM ANTES DO `limit(30)`. Se o
 * recorte de reação/sistema ficasse só no JavaScript, 30 reações mais novas
 * encheriam a página e a mensagem que conta ficaria de fora.
 *
 * Aqui o cliente falso aplica cada filtro com a semântica do SQL — `NULL` em
 * comparação não casa — e só então ordena e corta.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import { recebidasQueARespostaLe } from "@/lib/messaging/recebidas-a-ler";

type Linha = Record<string, unknown>;

const ORG = "org-5015";
const CONV = "conv-5015";
const ENVIO = "envio-em-curso";

/** `col` ou `col->>chave`, lido como o PostgREST lê: `->>` dá texto ou null. */
function valor(l: Linha, coluna: string): string | null {
  const [base, chave] = coluna.split("->>");
  const v = chave === undefined ? l[base!] : ((l[base!] ?? null) as Linha | null)?.[chave];
  return v === null || v === undefined ? null : String(v);
}

/** Um filtro do PostgREST: `null` quando o SQL daria NULL (não casa). */
type Filtro = (l: Linha) => boolean;

function porOperador(coluna: string, operador: string, alvo: unknown): Filtro {
  return (l) => {
    const v = valor(l, coluna);
    switch (operador) {
      case "eq":
        return v !== null && v === String(alvo);
      case "neq":
        return v !== null && v !== String(alvo);
      case "gt":
        return v !== null && v > String(alvo);
      case "in":
        return v !== null && (alvo as unknown[]).map(String).includes(v);
      case "is":
        if (alvo === null || alvo === "null") return v === null;
        throw new Error(`is.${String(alvo)} não implementado`);
      default:
        throw new Error(`operador ${operador} não implementado`);
    }
  };
}

function clienteQueFiltraComoOBanco(linhas: Linha[]): SupabaseClient {
  return {
    from(tabela: string) {
      if (tabela !== "messages") throw new Error(`tabela inesperada ${tabela}`);
      const filtros: Filtro[] = [];
      let ordem: { coluna: string; asc: boolean } | null = null;
      let teto = Infinity;
      const cadeia = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => (filtros.push(porOperador(c, "eq", v)), cadeia),
        neq: (c: string, v: unknown) => (filtros.push(porOperador(c, "neq", v)), cadeia),
        gt: (c: string, v: unknown) => (filtros.push(porOperador(c, "gt", v)), cadeia),
        in: (c: string, v: unknown[]) => (filtros.push(porOperador(c, "in", v)), cadeia),
        is: (c: string, v: null) => (filtros.push(porOperador(c, "is", v)), cadeia),
        not: (c: string, op: string, v: unknown) => {
          const lista = op === "in" ? String(v).replace(/^\(|\)$/g, "").split(",") : v;
          const f = porOperador(c, op, lista);
          // NOT de NULL é NULL: a linha com a coluna nula não casa nem o `not in`.
          filtros.push((l) => (op === "is" ? !f(l) : valor(l, c) !== null && !f(l)));
          return cadeia;
        },
        or: (expressao: string) => {
          const partes = expressao.split(",").map((p) => {
            const [coluna, operador, ...resto] = p.split(".");
            return porOperador(coluna!, operador!, resto.join("."));
          });
          filtros.push((l) => partes.some((f) => f(l)));
          return cadeia;
        },
        order: (coluna: string, o?: { ascending?: boolean }) => ((ordem = { coluna, asc: o?.ascending ?? true }), cadeia),
        limit: (n: number) => ((teto = n), cadeia),
        then: (resolve: (r: { data: Linha[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
          let data = linhas.filter((l) => filtros.every((f) => f(l)));
          if (ordem) {
            const { coluna, asc } = ordem;
            data = [...data].sort((a, b) => {
              const x = valor(a, coluna) ?? "";
              const y = valor(b, coluna) ?? "";
              return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
            });
          }
          return Promise.resolve({ data: data.slice(0, teto), error: null }).then(resolve, reject);
        },
      };
      return cadeia;
    },
  } as unknown as SupabaseClient;
}

const linha = (id: string, direction: string, createdAt: string, extra: Linha = {}): Linha => ({
  id,
  organization_id: ORG,
  conversation_id: CONV,
  direction,
  type: "text",
  status: direction === "inbound" ? "received" : "sent",
  external_id: direction === "inbound" ? `false_5531999998888@c.us_${id}` : `3EB0${id}`,
  created_at: createdAt,
  ...extra,
});

const ler = (linhas: Linha[]) =>
  recebidasQueARespostaLe(clienteQueFiltraComoOBanco(linhas), {
    organizationId: ORG,
    conversationId: CONV,
    envioId: ENVIO,
  });

describe("a leitura do #5015 na ordem do banco", () => {
  it("30 reações mais novas não empurram para fora a mensagem que conta", async () => {
    const reacoes = Array.from({ length: 31 }, (_, i) =>
      linha(`R${String(i).padStart(2, "0")}`, "inbound", `2026-11-20T10:01:${String(i).padStart(2, "0")}.000Z`, {
        type: "reaction",
      }),
    );
    const ids = await ler([linha("IN1", "inbound", "2026-11-20T10:00:00.000Z"), ...reacoes]);
    expect(ids).toEqual(["false_5531999998888@c.us_IN1"]);
  });
});
