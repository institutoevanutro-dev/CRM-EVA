import type { SupabaseClient } from "@supabase/supabase-js";
import { janela } from "./eventos-do-periodo";
import { origemDoContato, ROTULO_DA_ORIGEM } from "@/lib/inicio/paineis";
import type { TotaisMarketing } from "@/lib/integrations/financeiro/totais-marketing";
import { logger } from "@/lib/logger";

// Agregados da semana para o PDF do Marketing. Só contagens e nomes da equipe; paciente nenhum.
// Financeiro fora do ar vira `financeiro: null` (a página de vendas some do PDF); erro do banco lança.
export type Semana = {
  contatos_novos: { total: number; por_origem: { rotulo: string; total: number }[] };
  atendimento: { ia_sozinha: number; com_equipe: number; sem_resposta: number; mediana_primeira_resposta_s: number | null };
  mensagens: { via: string; mensagens: number; conversas: number }[];
  recebidas: number;
  agenda: { criados: number; realizados: number; faltas: number; cancelados: number };
  quem_marcou: { nome: string; total: number }[];
  financeiro: TotaisMarketing | null;
  /** Financeiro ligado, mas fora do ar nesta consulta (o Marketing tenta de novo em vez de mandar sem vendas). */
  financeiro_indisponivel: boolean;
};

async function rpc<T>(admin: SupabaseClient, nome: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data as T;
}

export async function consultaSemana(
  admin: SupabaseClient,
  org: string,
  de: string,
  ate: string,
  fin?: () => Promise<TotaisMarketing>,
): Promise<Semana> {
  const { inicio, fim } = janela(de, ate);
  const args = { p_org: org, p_inicio: inicio, p_fim: fim };
  const [semana, atend, origem, financeiro] = await Promise.all([
    rpc<Pick<Semana, "mensagens" | "recebidas" | "agenda" | "quem_marcou">>(admin, "fn_marketing_semana", args),
    rpc<Partial<Semana["atendimento"]> | null>(admin, "fn_inicio_atendimento", args),
    rpc<{ origem: string | null; total: number }[] | null>(admin, "fn_inicio_origem", args),
    fin
      ? fin().catch((err: unknown) => {
          logger.error("[marketing.semana] Financeiro indisponível", { error: err instanceof Error ? err.message : String(err) });
          return undefined;
        })
      : Promise.resolve(null),
  ]);
  const porRotulo = new Map<string, number>();
  for (const l of origem ?? []) {
    const rotulo = ROTULO_DA_ORIGEM[origemDoContato(l.origem ?? "")];
    porRotulo.set(rotulo, (porRotulo.get(rotulo) ?? 0) + Number(l.total ?? 0));
  }
  const por_origem = [...porRotulo].map(([rotulo, total]) => ({ rotulo, total })).sort((a, b) => b.total - a.total);
  return {
    contatos_novos: { total: por_origem.reduce((s, o) => s + o.total, 0), por_origem },
    atendimento: {
      ia_sozinha: atend?.ia_sozinha ?? 0,
      com_equipe: atend?.com_equipe ?? 0,
      sem_resposta: atend?.sem_resposta ?? 0,
      mediana_primeira_resposta_s: atend?.mediana_primeira_resposta_s ?? null,
    },
    mensagens: semana.mensagens ?? [],
    recebidas: semana.recebidas ?? 0,
    agenda: semana.agenda,
    quem_marcou: semana.quem_marcou ?? [],
    financeiro: financeiro ?? null,
    financeiro_indisponivel: financeiro === undefined,
  };
}
