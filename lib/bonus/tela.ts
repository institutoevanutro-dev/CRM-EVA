import type { PlacarDaPessoa, PlacarDoMes, ResultadoDoCriterio } from "./calculo";
import type { RegrasDoBonus } from "./regras";
import type { MotivoDeLigacao, ResultadoDeLigacao, TipoDeItemDaFila } from "./tipos";

export interface RespostaDoPrograma {
  programa: { id: string; ativo: boolean; aprovador_user_id: string; regras: RegrasDoBonus } | null;
  pode_criar: boolean;
}

export interface ItemDaFilaNaTela {
  id: string;
  tipo: TipoDeItemDaFila;
  contato_nome: string;
  telefone: string | null;
  conversation_id: string | null;
  motivo: MotivoDeLigacao | null;
  enviada: boolean;
  ligacao_resultado: ResultadoDeLigacao | null;
  ligacao_resumo: string | null;
}

export interface RespostaMeuBonus {
  mes: string;
  hoje: string;
  mes_de_teste: boolean;
  resultados: ResultadoDoCriterio[];
  resultados_cents: number;
  pessoa: PlacarDaPessoa;
  stories_hoje: { contagem: number; meta: number };
  /** `null` quando o mês pedido não é o de hoje. */
  fila: ItemDaFilaNaTela[] | null;
  janela: { aberta: boolean; abre_em: string | null } | null;
}

export interface RespostaDaEquipe {
  mes: string;
  hoje: string;
  placar: PlacarDoMes;
  nomes: Record<string, string | null>;
  stories_hoje: { contagem: number; leitura_erro: string | null };
  fila_reduzida_hoje: boolean;
}

/**
 * O período aberto do lançamento manual de stories: do dia 1 do mês de hoje
 * até hoje. Mês fechado não se mexe pela tela, e dia futuro ainda não
 * aconteceu. O `input type=date` com min/max já barra o calendário; esta
 * conferência repete a régua para o que for digitado à mão.
 */
export function periodoAberto(hoje: string): { min: string; max: string } {
  return { min: `${hoje.slice(0, 8)}01`, max: hoje };
}

/**
 * O dia cai no período aberto. Dia impossível (31/02, dia 00) fica fora sozinho:
 * ele é sempre maior que o último dia real do mês, que é >= hoje, ou menor que
 * o dia 01.
 */
export function diaNoPeriodo(dia: string, hoje: string): boolean {
  const { min, max } = periodoAberto(hoje);
  return /^\d{4}-\d{2}-\d{2}$/.test(dia) && dia >= min && dia <= max;
}
