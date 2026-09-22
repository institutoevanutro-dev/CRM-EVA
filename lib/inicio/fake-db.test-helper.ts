/**
 * Dublê que APLICA os filtros sobre linhas em memória (mesma ideia de
 * app/api/v1/agenda/vinculos/route.test.ts): sem isso, tirar o
 * `.eq("organization_id", …)` de um bloco deixaria os testes verdes.
 */
type Linha = Record<string, unknown>;

export function fakeDb(tabelas: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let ordem: { col: string; asc: boolean } | null = null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      not: (c: string, op: string, v: unknown) => {
        if (op === "is") filtros.push((l) => (l[c] ?? null) !== v);
        else if (op === "in") {
          const lista = String(v).replace(/^\(|\)$/g, "").split(",");
          filtros.push((l) => !lista.includes(String(l[c])));
        } else throw new Error(`not.${op} não suportado no dublê`);
        return q;
      },
      gte: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) >= v), q),
      lt: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) < v), q),
      lte: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) <= v), q),
      order: (col: string, o?: { ascending?: boolean }) => (
        (ordem = { col, asc: o?.ascending !== false }), q
      ),
      limit: (n: number) => ((limite = n), q),
      then: (resolve: (r: { data: Linha[]; error: null; count: number }) => unknown) => {
        const todas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const { col, asc } = ordem;
          todas.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return resolve({ data: todas.slice(0, limite), error: null, count: todas.length });
      },
    };
    return q;
  };
  return { db: { from } as never };
}
