/**
 * Fake mínimo do client supabase-js para testes de rota: grava cada operação
 * (tabela, ação, dados, filtros) e devolve o que o teste mandou. O builder é
 * "thenable", então `await supabase.from(...).update(...).eq(...)` funciona.
 */
export interface OperacaoGravada {
  tabela: string;
  acao: "select" | "insert" | "update" | "upsert" | "delete";
  dados?: unknown;
  filtros: Array<[string, string, unknown]>;
}

type Resposta = { data: unknown; error: unknown; count?: number | null };

export function supabaseGravador(responder: (op: OperacaoGravada) => Resposta = () => ({ data: null, error: null })) {
  const ops: OperacaoGravada[] = [];
  function from(tabela: string) {
    const op: OperacaoGravada = { tabela, acao: "select", filtros: [] };
    ops.push(op);
    const resultado = () => Promise.resolve(responder(op));
    const b: Record<string, unknown> = {};
    const filtro = (tipo: string) => (coluna: string, valor: unknown) => {
      op.filtros.push([tipo, coluna, valor]);
      return b;
    };
    Object.assign(b, {
      select: () => b,
      insert: (dados: unknown) => {
        op.acao = "insert";
        op.dados = dados;
        return b;
      },
      update: (dados: unknown) => {
        op.acao = "update";
        op.dados = dados;
        return b;
      },
      upsert: (dados: unknown) => {
        op.acao = "upsert";
        op.dados = dados;
        return b;
      },
      delete: () => {
        op.acao = "delete";
        return b;
      },
      eq: filtro("eq"),
      in: filtro("in"),
      is: filtro("is"),
      or: (expressao: string) => {
        op.filtros.push(["or", expressao, null]);
        return b;
      },
      gte: filtro("gte"),
      order: () => b,
      limit: () => b,
      single: resultado,
      maybeSingle: resultado,
      then: (sucesso: (v: Resposta) => unknown, falha?: (e: unknown) => unknown) => resultado().then(sucesso, falha),
    });
    return b;
  }
  return { cliente: { from }, ops };
}
