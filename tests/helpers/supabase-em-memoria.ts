/**
 * Um PostgREST de mentira, com estado, para testar rota contra dado que muda.
 *
 * Só o que as rotas de pedido LGPD usam: `select/eq/in/gt/order/limit`,
 * `maybeSingle/single`, `insert`, `update` e `rpc` (espionado). Os filtros são
 * aplicados de verdade: é o que deixa o teste de isolamento entre organizações
 * falhar quando a rota esquece o `organization_id`.
 */
import { vi } from "vitest";

export type Linha = Record<string, unknown>;
type Resposta = { data: unknown; error: { code: string; message: string } | null };

export function supabaseEmMemoria(tabelas: Record<string, Linha[]>) {
  let seq = 0;
  /** Erro devolvido pela próxima gravação nessa tabela (simula recusa do banco). */
  const recusar: Record<string, { code: string; message: string } | undefined> = {};
  const rpc = vi.fn(async () => ({ data: null, error: null }));

  function from(tabela: string) {
    const linhas = (tabelas[tabela] ??= []);
    const filtros: Array<(l: Linha) => boolean> = [];
    let acao: { tipo: "select" } | { tipo: "insert"; linha: Linha } | { tipo: "update"; patch: Linha } = {
      tipo: "select",
    };
    let limite = Infinity;

    function executar(): Resposta {
      if (acao.tipo !== "select" && recusar[tabela]) return { data: null, error: recusar[tabela]! };
      if (acao.tipo === "insert") {
        const criada = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...acao.linha };
        linhas.push(criada);
        return { data: [criada], error: null };
      }
      const achadas = linhas.filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      if (acao.tipo === "update") for (const l of achadas) Object.assign(l, acao.patch);
      return { data: achadas, error: null };
    }
    const uma = (obrigatoria: boolean) => async (): Promise<Resposta> => {
      const r = executar();
      if (r.error) return r;
      const [primeira] = r.data as Linha[];
      if (!primeira && obrigatoria) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: primeira ?? null, error: null };
    };

    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      gt: (c: string, v: unknown) => (filtros.push((l) => String(l[c]) > String(v)), q),
      order: () => q,
      limit: (n: number) => ((limite = n), q),
      insert: (linha: Linha) => ((acao = { tipo: "insert", linha }), q),
      update: (patch: Linha) => ((acao = { tipo: "update", patch }), q),
      maybeSingle: uma(false),
      single: uma(true),
      then: (ok: (r: Resposta) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(ok, falha),
    };
    return q;
  }

  return { cliente: { from, rpc }, tabelas, recusar, rpc };
}
