/**
 * As contas do Painel do funil — funções PURAS, sem banco nem rede.
 *
 * A rota `GET /api/v1/metrics/funil` lê; isto conta. Cada régua aqui é a mesma
 * que a tela escreve embaixo do número
 * (`docs/superpowers/specs/2026-10-06-painel-do-funil-design.md` §2).
 *
 * Duas naturezas de número, e a régua de cada um diz qual é:
 * - COORTE (leads, interagiram, funil por etapa): cards CRIADOS no período;
 * - EVENTO (ganhos, agenda): desfechos que ACONTECERAM no período.
 *
 * `null` é "não dá para medir"; nunca vira `0`.
 */
import { normalizarTag } from "@/lib/contacts/tag-normalizada";
import { inicioDoDiaNoFuso } from "@/lib/plataformas-de-anuncio/meta/resultado-crm";

/** Sem função SQL, a rota varre linhas: a janela tem teto (mesmo de `/reports/tags`). */
export const DIAS_MAXIMOS = 90;

const DIA_MS = 86_400_000;

function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** 30 dias terminando ONTEM: o dia corrente está incompleto (ver a rota de campanhas). */
export function periodoPadrao(agora: Date, fuso: string): { de: string; ate: string } {
  const hoje = agora.toLocaleDateString("en-CA", { timeZone: fuso });
  const ate = somarDias(hoje, -1);
  return { de: somarDias(ate, -29), ate };
}

/** `[início do dia de, início do dia seguinte a ate)` no fuso. Lança `RangeError`. */
export function janelaDoPeriodo({ de, ate, fuso }: { de: string; ate: string; fuso: string }): {
  inicio: string;
  fimExclusivo: string;
  dias: number;
} {
  const dias =
    Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_MS) + 1;
  if (dias < 1) throw new RangeError("periodo_invertido");
  if (dias > DIAS_MAXIMOS) throw new RangeError("periodo_longo");
  return {
    inicio: inicioDoDiaNoFuso(de, fuso),
    fimExclusivo: inicioDoDiaNoFuso(somarDias(ate, 1), fuso),
    dias,
  };
}

// ─── Etapas ─────────────────────────────────────────────────────────────────

export interface Etapa {
  id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  agent_stage_hint: string | null;
}

/**
 * As etapas citadas por um `stage_changed`, nas DUAS gramáticas que existem:
 * `{from_stage_id,to_stage_id}` (humano, API, automação) e `{de,para}` (agente,
 * agenda, handoff, supervisão). Ler só uma esconderia os movimentos da máquina.
 */
function etapasDoMovimento(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  return [p.from_stage_id ?? p.de, p.to_stage_id ?? p.para].filter(
    (x): x is string => typeof x === "string",
  );
}

/**
 * A maior posição que o card alcançou: etapa atual + as dos movimentos.
 * Ignora perda (não é avanço), etapa ARQUIVADA (depois de reorganizar o funil a
 * posição dela não diz nada) e etapa de outro funil (fora do mapa).
 */
export function posicaoAlcancada(
  card: { stage_id: string },
  movimentos: { payload: unknown }[],
  etapasPorId: Map<string, Etapa>,
): number | null {
  let maior: number | null = null;
  for (const id of [card.stage_id, ...movimentos.flatMap((m) => etapasDoMovimento(m.payload))]) {
    const e = etapasPorId.get(id);
    if (!e || e.is_lost || e.is_archived) continue;
    if (maior === null || e.position > maior) maior = e.position;
  }
  return maior;
}

/** A etapa ATIVA ligada ao passo "Primeiro contato" do agente (só pode haver uma). */
export function etapaDeInteracao(etapas: Etapa[]): Etapa | null {
  return etapas.find((e) => !e.is_archived && e.agent_stage_hint === "contacted") ?? null;
}

/** O card chegou à etapa de interação? `null` quando o funil não tem essa etapa. */
export function interagiu(alcancada: number | null, interacao: Etapa | null): boolean | null {
  if (!interacao) return null;
  return alcancada !== null && alcancada >= interacao.position;
}

const razao = (num: number | null, den: number): number | null =>
  num === null || den === 0 ? null : num / den;

export function agregarCoorte({
  etapas,
  cards,
  movimentosPorCard,
}: {
  etapas: Etapa[];
  cards: { id: string; stage_id: string; status: string }[];
  movimentosPorCard: Map<string, { payload: unknown }[]>;
}) {
  const porId = new Map(etapas.map((e) => [e.id, e]));
  const interacao = etapaDeInteracao(etapas);
  const alcancadas = cards.map((c) =>
    posicaoAlcancada(c, movimentosPorCard.get(c.id) ?? [], porId),
  );
  const interagiram = interacao ? alcancadas.filter((a) => interagiu(a, interacao)).length : null;
  return {
    leads: cards.length,
    interagiram,
    taxa_interacao: razao(interagiram, cards.length),
    por_etapa: etapas
      .filter((e) => !e.is_archived && !e.is_lost)
      .sort((a, b) => a.position - b.position)
      .map((e) => ({
        stage_id: e.id,
        nome: e.name,
        alcancaram: alcancadas.filter((a) => a !== null && a >= e.position).length,
      })),
    perdidos: cards.filter((c) => c.status === "lost").length,
    aviso: interacao ? null : ("sem_etapa_de_interacao" as const),
  };
}

// ─── Ganhos ─────────────────────────────────────────────────────────────────

export interface ValorPorMoeda {
  moeda: string;
  /** bigint serializado — soma de centavos não cabe garantido em `number`. */
  cents: string;
}

function somarPorMoeda(
  itens: { value_cents: number | string | null; currency: string | null }[],
): ValorPorMoeda[] {
  const soma = new Map<string, bigint>();
  for (const i of itens) {
    if (i.value_cents === null || !i.currency) continue;
    soma.set(i.currency, (soma.get(i.currency) ?? 0n) + BigInt(i.value_cents));
  }
  return [...soma]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([moeda, cents]) => ({ moeda, cents: cents.toString() }));
}

export function agregarGanhos(
  cards: { value_cents: number | string | null; currency: string | null }[],
) {
  return {
    ganhos: cards.length,
    receita: somarPorMoeda(cards),
    sem_valor: cards.filter((c) => c.value_cents === null).length,
    sem_moeda: cards.filter((c) => c.value_cents !== null && !c.currency).length,
  };
}

// ─── Agenda ─────────────────────────────────────────────────────────────────

export function agregarAgenda(compromissos: { status: string; ends_at: string }[], agora: number) {
  const vivos = compromissos.filter((c) => c.status !== "cancelled");
  const realizados = vivos.filter((c) => c.status === "completed").length;
  const faltas = vivos.filter((c) => c.status === "no_show").length;
  return {
    agendados: vivos.length,
    realizados,
    faltas,
    sem_baixa: vivos.filter(
      (c) => (c.status === "pending" || c.status === "confirmed") && Date.parse(c.ends_at) < agora,
    ).length,
    cancelados: compromissos.length - vivos.length,
    taxa_comparecimento: razao(realizados, realizados + faltas),
  };
}

// ─── Custo e ROAS ───────────────────────────────────────────────────────────

export function custoERoas({
  investimento,
  ganhosDeAnuncio,
  receitaDeAnuncio,
}: {
  investimento: { estado: "ok"; moeda: string; cents: number } | { estado: string };
  ganhosDeAnuncio: number;
  receitaDeAnuncio: ValorPorMoeda[];
}): { custo_por_venda_cents: number | null; roas: number | null } {
  if (investimento.estado !== "ok" || !("cents" in investimento)) {
    return { custo_por_venda_cents: null, roas: null };
  }
  const receita = receitaDeAnuncio.find((r) => r.moeda === investimento.moeda);
  return {
    custo_por_venda_cents:
      ganhosDeAnuncio > 0 ? Math.round(investimento.cents / ganhosDeAnuncio) : null,
    roas: receita && investimento.cents > 0 ? Number(receita.cents) / investimento.cents : null,
  };
}

// ─── Dimensão ───────────────────────────────────────────────────────────────

/** Um só balde de ausência; a tela escolhe a frase pela dimensão. */
export const SEM_VALOR = "__sem_valor";
/** Valor que não é opção cadastrada — sem o texto digitado (pode ser PII). */
export const FORA_DA_LISTA = "__fora_da_lista";

export type Dimensao =
  | {
      tipo: "campo_contato" | "campo_card";
      campo: string;
      opcoes: { value: string; label: string }[];
    }
  | { tipo: "etiqueta"; prefixo: string }
  | { tipo: "campanha" };

interface ContatoDaDimensao {
  custom_fields: unknown;
  tags: string[] | null;
  is_anonymized: boolean;
}

function valorDoCampo(customFields: unknown, campo: string, opcoes: { value: string }[]): string {
  const bruto =
    customFields && typeof customFields === "object" && !Array.isArray(customFields)
      ? (customFields as Record<string, unknown>)[campo]
      : undefined;
  if (bruto === undefined || bruto === null || bruto === "") return SEM_VALOR;
  return typeof bruto === "string" && opcoes.some((o) => o.value === bruto) ? bruto : FORA_DA_LISTA;
}

/**
 * As chaves de balde de um card. Contato ANONIMIZADO não tem valor em dimensão
 * de contato nem campanha — mesma exclusão da tela Meta Ads (`resultado-crm.ts`).
 */
export function valoresDaDimensao(
  d: Dimensao,
  {
    card,
    contato,
    campanha,
  }: {
    card?: { custom_fields: unknown } | null;
    contato?: ContatoDaDimensao | null;
    campanha?: string | null;
  },
): string[] {
  if (d.tipo === "campo_card") return [valorDoCampo(card?.custom_fields, d.campo, d.opcoes)];
  if (!contato || contato.is_anonymized) return [SEM_VALOR];
  if (d.tipo === "campanha") return [campanha ?? SEM_VALOR];
  if (d.tipo !== "etiqueta") return [valorDoCampo(contato.custom_fields, d.campo, d.opcoes)];
  // A etiqueta de CONTATO é gravada como foi digitada (`tag-normalizada.ts`).
  const prefixo = normalizarTag(d.prefixo);
  const achadas = [...new Set((contato.tags ?? []).map(normalizarTag))].filter(
    (t) => t.length > 0 && t.startsWith(prefixo),
  );
  return achadas.length ? achadas : [SEM_VALOR];
}

/**
 * O card deste funil a que um compromisso pertence.
 *
 * Com vínculo: o vínculo MAIS RECENTE a um card deste funil (o vínculo é gravado
 * a cada transição, então um compromisso pode ter vários). Vínculo só a card de
 * outro funil → não é deste. Sem vínculo nenhum: o card mais recente do contato
 * neste funil.
 */
export function cardDoCompromisso<C extends { id: string; created_at: string }>(
  compromisso: { contact_id: string | null },
  vinculos: { lead_id: string; created_at: string }[],
  cardsDoFunil: Map<string, C>,
  cardsDoFunilPorContato: Map<string, C[]>,
): C | null {
  const maisRecente = <T extends { created_at: string }>(xs: T[]): T | undefined =>
    xs.reduce<T | undefined>((a, b) => (!a || b.created_at > a.created_at ? b : a), undefined);
  if (vinculos.length > 0) {
    const v = maisRecente(vinculos.filter((x) => cardsDoFunil.has(x.lead_id)));
    return v ? cardsDoFunil.get(v.lead_id)! : null;
  }
  if (!compromisso.contact_id) return null;
  return maisRecente(cardsDoFunilPorContato.get(compromisso.contact_id) ?? []) ?? null;
}

export interface LinhaDaDimensao {
  chave: string;
  /** Rótulo cadastrado; `null` nos baldes especiais (a tela escreve a frase). */
  rotulo: string | null;
  leads: number;
  interagiram: number | null;
  ganhos: number;
  receita: ValorPorMoeda[];
  agendados: number;
  realizados: number;
  /** Só em `campanha`: gasto da campanha no período; `null` no balde sem campanha. */
  investimento_cents?: number | null;
}

export function agregarPorDimensao({
  dimensao,
  temEtapaDeInteracao,
  coorte,
  ganhos,
  agenda,
  campanhas,
}: {
  dimensao: Dimensao;
  /**
   * `etapaDeInteracao(etapas) !== null`. O "não dá para medir" vem da ETAPA, não
   * da coorte: coorte vazia não tem card para dizer que falta a etapa.
   */
  temEtapaDeInteracao: boolean;
  coorte: { chaves: string[]; interagiu: boolean | null }[];
  ganhos: { chaves: string[]; value_cents: number | string | null; currency: string | null }[];
  agenda: { chaves: string[]; status: string }[];
  campanhas?: Map<string, { nome: string; cents: number }>;
}): LinhaDaDimensao[] {
  const usadas = new Set([...coorte, ...ganhos, ...agenda].flatMap((x) => x.chaves));
  const especiais = [SEM_VALOR, FORA_DA_LISTA].filter((k) => usadas.has(k));

  let base: { chave: string; rotulo: string }[];
  if (dimensao.tipo === "campo_contato" || dimensao.tipo === "campo_card") {
    base = dimensao.opcoes.map((o) => ({ chave: o.value, rotulo: o.label }));
  } else if (dimensao.tipo === "etiqueta") {
    base = [...usadas]
      .filter((k) => !especiais.includes(k))
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({ chave: k, rotulo: k }));
  } else {
    const ids = new Set([
      ...(campanhas?.keys() ?? []),
      ...[...usadas].filter((k) => !especiais.includes(k)),
    ]);
    base = [...ids]
      .map((id) => ({ chave: id, rotulo: campanhas?.get(id)?.nome ?? id }))
      .sort(
        (a, b) =>
          (campanhas?.get(b.chave)?.cents ?? 0) - (campanhas?.get(a.chave)?.cents ?? 0) ||
          a.chave.localeCompare(b.chave),
      );
  }

  const linhas = [...base, ...especiais.map((chave) => ({ chave, rotulo: null }))];
  return linhas.map(({ chave, rotulo }) => {
    const daqui = <T extends { chaves: string[] }>(xs: T[]) =>
      xs.filter((x) => x.chaves.includes(chave));
    const coorteDaqui = daqui(coorte);
    const ganhosDaqui = daqui(ganhos);
    const agendaDaqui = daqui(agenda).filter((a) => a.status !== "cancelled");
    const linha: LinhaDaDimensao = {
      chave,
      rotulo,
      leads: coorteDaqui.length,
      interagiram: temEtapaDeInteracao ? coorteDaqui.filter((c) => c.interagiu).length : null,
      ganhos: ganhosDaqui.length,
      receita: somarPorMoeda(ganhosDaqui),
      agendados: agendaDaqui.length,
      realizados: agendaDaqui.filter((a) => a.status === "completed").length,
    };
    if (dimensao.tipo === "campanha") {
      linha.investimento_cents = rotulo === null ? null : (campanhas?.get(chave)?.cents ?? 0);
    }
    return linha;
  });
}
