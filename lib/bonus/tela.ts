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
