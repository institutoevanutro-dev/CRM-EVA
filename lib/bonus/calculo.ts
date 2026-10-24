/**
 * O CÁLCULO DO MÊS do bônus da equipe — puro, sem banco e sem fuso.
 *
 * Tudo é dia LOCAL (`YYYY-MM-DD`), já convertido pelo coletor (`fatos.ts`).
 * Comparar strings de dia é o que torna "concluída até o fim do dia do prazo"
 * exato: `diaDoFechamento <= diaDoPrazo`.
 *
 * Item PENDENTE (ainda dá para fazer) não pesa nem a favor nem contra: o placar
 * do meio do mês mostra "se o mês fechasse hoje" sem punir o dia em andamento.
 */
import { diasUteisDoMes } from "./calendario";
import type { RegrasDoBonus } from "./regras";
import { CHAVES_DE_RESULTADO, type ChaveDeResultado } from "./tipos";

export type SituacaoDaTarefaNoMes = "aberta" | "feita" | "cancelada";

export interface TarefaDoMes {
  id: string;
  diaDoPrazo: string;
  situacao: SituacaoDaTarefaNoMes;
  diaDoFechamento: string | null;
  prazoTrocadoAposVencer: boolean;
}

export interface RotinaDoDia {
  dia: string;
  meta: number;
  feitos: number;
}

export interface FatosDaPessoa {
  userId: string;
  tarefas: TarefaDoMes[];
  leads: RotinaDoDia[];
  ligacoes: RotinaDoDia[];
  /** Férias, atestado: as rotinas desses dias saem da conta da pessoa (Etapa 2 preenche). */
  diasDeExcecao: string[];
}

export interface ContagensDoMes {
  comparecimento: number;
  sinal_pago: number;
  /** `null` = ainda não lançada (o aprovador digita no fechamento). */
  avaliacao_google: number | null;
}

export interface EntradaDoMes {
  mes: string;
  hoje: string;
  /** Dia local (`YYYY-MM-DD`) em que o programa começou; `null` = sem corte. Dias antes saem das rotinas, como feriado. */
  inicioDoPrograma: string | null;
  regras: RegrasDoBonus;
  pessoas: FatosDaPessoa[];
  storiesPorDia: Record<string, number>;
  resultados: ContagensDoMes;
}

export type DesfechoDoItem = "feito" | "nao_feito" | "pendente" | "fora";

export interface ItemNaoFeito {
  tipo: "tarefa" | "leads" | "ligacoes" | "stories";
  /** id da tarefa, ou o dia da rotina. */
  ref: string;
  motivo: "atrasada" | "prazo_trocado" | "em_aberto" | "incompleta";
}

export interface PlacarDasTarefas {
  devidos: number;
  feitos: number;
  pendentes: number;
  /** `null` quando nada foi devido ainda. */
  percentualBps: number | null;
  fracaoBps: number;
  valorCents: number;
  naoFeitos: ItemNaoFeito[];
}

export interface PlacarDaPessoa {
  userId: string;
  tarefas: PlacarDasTarefas;
  resultadosCents: number;
  totalCents: number;
}

export interface ResultadoDoCriterio {
  chave: ChaveDeResultado;
  contagem: number | null;
  basica: number | null;
  alta: number | null;
  valorCents: number;
  faixa: "alta" | "basica" | "nenhuma" | "sem_meta" | "pendente";
}

export interface PlacarDoMes {
  mes: string;
  mesDeTeste: boolean;
  resultados: ResultadoDoCriterio[];
  resultadosCents: number;
  pessoas: PlacarDaPessoa[];
}

export function desfechoDaTarefa(t: TarefaDoMes, hoje: string): DesfechoDoItem {
  if (t.prazoTrocadoAposVencer) return "nao_feito";
  const noPrazo = t.diaDoFechamento !== null && t.diaDoFechamento <= t.diaDoPrazo;
  if (t.situacao === "feita") return noPrazo ? "feito" : "nao_feito";
  if (t.situacao === "cancelada") return noPrazo ? "fora" : "nao_feito";
  return t.diaDoPrazo < hoje ? "nao_feito" : "pendente";
}

export function desfechoDaRotina(meta: number, feitos: number, dia: string, hoje: string): DesfechoDoItem {
  if (meta <= 0 || dia > hoje) return "fora";
  if (feitos >= meta) return "feito";
  return dia < hoje ? "nao_feito" : "pendente";
}

export function fracaoDaFaixa(
  feitos: number,
  devidos: number,
  faixas: RegrasDoBonus["tarefas"]["faixas"],
): number {
  if (devidos === 0) return 10_000;
  const ordenadas = [...faixas].sort((a, b) => b.minimo_bps - a.minimo_bps);
  // Inteiro dos dois lados: 9 de 10 contra 9000 bps é 90000 >= 90000.
  for (const f of ordenadas) if (feitos * 10_000 >= f.minimo_bps * devidos) return f.fracao_bps;
  return 0;
}

export function avaliarCriterio(
  chave: ChaveDeResultado,
  contagem: number | null,
  valorCents: number,
  meta: { basica: number; alta: number } | undefined,
): ResultadoDoCriterio {
  const base = { chave, contagem, basica: meta?.basica ?? null, alta: meta?.alta ?? null };
  if (!meta) return { ...base, valorCents: 0, faixa: "sem_meta" };
  if (contagem === null) return { ...base, valorCents: 0, faixa: "pendente" };
  if (contagem >= meta.alta) return { ...base, valorCents, faixa: "alta" };
  if (contagem >= meta.basica) return { ...base, valorCents: Math.floor(valorCents / 2), faixa: "basica" };
  return { ...base, valorCents: 0, faixa: "nenhuma" };
}

function placarDaPessoa(
  p: FatosDaPessoa,
  e: EntradaDoMes,
  diasUteis: ReadonlySet<string>,
  resultadosCents: number,
): PlacarDaPessoa {
  let devidos = 0;
  let feitos = 0;
  let pendentes = 0;
  const naoFeitos: ItemNaoFeito[] = [];
  const contar = (desfecho: DesfechoDoItem, item: ItemNaoFeito) => {
    if (desfecho === "fora") return;
    if (desfecho === "pendente") {
      pendentes += 1;
      return;
    }
    devidos += 1;
    if (desfecho === "feito") feitos += 1;
    else naoFeitos.push(item);
  };

  for (const t of p.tarefas) {
    if (!t.diaDoPrazo.startsWith(e.mes)) continue;
    const motivo = t.prazoTrocadoAposVencer ? "prazo_trocado" : t.situacao === "aberta" ? "em_aberto" : "atrasada";
    contar(desfechoDaTarefa(t, e.hoje), { tipo: "tarefa", ref: t.id, motivo });
  }

  const excecoes = new Set(p.diasDeExcecao);
  const vale = (dia: string) => diasUteis.has(dia) && !excecoes.has(dia) && (e.inicioDoPrograma === null || dia >= e.inicioDoPrograma);
  for (const r of p.leads) {
    if (vale(r.dia)) contar(desfechoDaRotina(r.meta, r.feitos, r.dia, e.hoje), { tipo: "leads", ref: r.dia, motivo: "incompleta" });
  }
  for (const r of p.ligacoes) {
    if (vale(r.dia)) contar(desfechoDaRotina(r.meta, r.feitos, r.dia, e.hoje), { tipo: "ligacoes", ref: r.dia, motivo: "incompleta" });
  }
  const metaDeStories = e.regras.rotinas.stories_por_dia;
  for (const dia of diasUteis) {
    if (vale(dia)) {
      contar(desfechoDaRotina(metaDeStories, e.storiesPorDia[dia] ?? 0, dia, e.hoje), { tipo: "stories", ref: dia, motivo: "incompleta" });
    }
  }

  const fracaoBps = fracaoDaFaixa(feitos, devidos, e.regras.tarefas.faixas);
  const valorCents = Math.floor((e.regras.tarefas.valor_cents * fracaoBps) / 10_000);
  const soma = valorCents + resultadosCents;
  const teto = e.regras.teto_cents;
  return {
    userId: p.userId,
    tarefas: {
      devidos,
      feitos,
      pendentes,
      percentualBps: devidos === 0 ? null : Math.floor((feitos * 10_000) / devidos),
      fracaoBps,
      valorCents,
      naoFeitos,
    },
    resultadosCents,
    totalCents: teto === null ? soma : Math.min(soma, teto),
  };
}

export function calcularMes(e: EntradaDoMes): PlacarDoMes {
  const teste = e.regras.meses_de_teste[e.mes];
  const metas = e.regras.metas_por_mes[e.mes];
  const resultados = CHAVES_DE_RESULTADO.map((chave) =>
    avaliarCriterio(chave, e.resultados[chave], e.regras.resultados[chave].valor_cents, metas?.[chave]),
  );
  const resultadosCents = teste
    ? teste.garantia_resultados_cents
    : resultados.reduce((soma, r) => soma + r.valorCents, 0);
  const diasUteis = new Set(diasUteisDoMes(e.mes, e.regras.feriados));
  return {
    mes: e.mes,
    mesDeTeste: Boolean(teste),
    resultados,
    resultadosCents,
    pessoas: e.pessoas.map((p) => placarDaPessoa(p, e, diasUteis, resultadosCents)),
  };
}
