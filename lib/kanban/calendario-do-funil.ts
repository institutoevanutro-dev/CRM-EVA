import { diaLocalISO } from "@/lib/agenda/fuso";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import type { Lead } from "@/lib/types/leads";

/**
 * As datas do funil em dias de calendário.
 *
 * Porte do upstream melgarafael/DeskcommCRM#2790 (@webtecnica), com três
 * diferenças deste fork:
 *
 *   1. O DIA É O DA ORGANIZAÇÃO, não o do navegador nem o do servidor. Um
 *      carimbo com hora (`created_at`, ou data cheia vinda de importação) é lido
 *      no fuso da organização, pela mesma `diaLocalISO` da Agenda. O original
 *      usava `getDate()` do navegador: quem abre o CRM de Tóquio via o negócio
 *      das 23:30 de São Paulo no dia seguinte.
 *   2. A GRADE É FEITA DE CHAVES (`YYYY-MM-DD`), não de `Date`. Toda a conta de
 *      dia (somar, achar o domingo, montar o mês) é em UTC sobre a chave, então
 *      o resultado é o mesmo com o processo em UTC, São Paulo ou Tóquio.
 *   3. QUEM NÃO TEM DATA É CONTADO (`semData`), não descartado em silêncio. A
 *      tela mostra a lista dos sem data; a grade continua sem inventar um dia.
 *
 * ─── A regra de quem aparece ───────────────────────────────────────────────
 *
 * Só entra no dia quem TEM data válida no campo escolhido. Um negócio sem
 * preenchimento não é colocado em "hoje" nem no fim do mês.
 */

/** Chaves dos campos NATIVOS do negócio. Começam por `@`: chave de campo
 *  personalizado começa por letra (`customFieldSchema`), então não colidem. */
export const CAMPO_FECHAMENTO = "@expected_close_date";
export const CAMPO_CRIACAO = "@created_at";

export interface CampoDeData {
  key: string;
  /** Rótulo. O dos nativos é texto do dicionário (passa por `t`). */
  label: string;
  nativo: boolean;
}

/**
 * Os campos que podem dirigir o calendário: os de tipo `date` de
 * `settings.fields` (o que o upstream oferece) e, DEPOIS deles, os dois nativos
 * do negócio. Sem os nativos, um funil sem campo de data personalizado (o caso
 * comum de uma clínica) abriria a visão só para ler "não há campo de data".
 */
export function camposDeData(settings: Record<string, unknown> | null | undefined): CampoDeData[] {
  return [
    ...camposDoFunil(settings)
      .filter((c) => c.type === "date")
      .map((c) => ({ key: c.key, label: c.label, nativo: false })),
    { key: CAMPO_FECHAMENTO, label: "Fechamento previsto", nativo: true },
    { key: CAMPO_CRIACAO, label: "Criado em", nativo: true },
  ];
}

/**
 * O campo que a visão abre quando ninguém escolheu: o primeiro campo de data do
 * funil (como no upstream) e, sem nenhum, a data de criação, que todo negócio
 * tem. "Fechamento previsto" quase nunca está preenchido, e abrir nele seria
 * uma grade vazia na primeira vez que a pessoa clica.
 */
export function campoPadrao(campos: readonly CampoDeData[]): string {
  return campos.find((c) => !c.nativo)?.key ?? CAMPO_CRIACAO;
}

function valorDoCampo(lead: Lead, campo: string): unknown {
  if (campo === CAMPO_CRIACAO) return lead.created_at;
  if (campo === CAMPO_FECHAMENTO) return lead.expected_close_date;
  return lead.custom_fields?.[campo];
}

const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Data cheia: o dia, um `T` ou espaço, e o resto. */
const RE_CARIMBO = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}/;
/** `Z` ou `+hh:mm` / `-hh:mm` / `+hhmm` / `+hh` no fim: o carimbo diz o próprio fuso. */
const RE_OFFSET = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function diaExiste(chave: string): boolean {
  const p = RE_DIA.exec(chave);
  if (!p) return false;
  const [ano, mes, dia] = [Number(p[1]), Number(p[2]), Number(p[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/**
 * O dia que um valor de campo significa, ou `null` se ele não é data.
 *
 *   - `2026-03-10` (o que `<input type="date">` grava): é o próprio dia, lido
 *     por pedaços. NÃO passa por `new Date()`, que o leria como meia-noite UTC.
 *   - carimbo COM fuso (`...Z`, `...-03:00`): é um instante, e o dia é o que o
 *     relógio da ORGANIZAÇÃO mostrava nele.
 *   - carimbo SEM fuso (`2026-03-10T23:30:00`): hora de parede, sem instante.
 *     Vale o dia escrito; `new Date()` o leria no fuso do processo.
 *
 * Qualquer outro formato (`10/03/2026`, texto) é `null`: o `Date` do JS leria
 * `10/03` como 3 de outubro, e data errada é pior que "sem data".
 */
export function diaDe(valor: unknown, fuso: string): string | null {
  if (typeof valor !== "string") return null;
  const bruto = valor.trim();
  if (RE_DIA.test(bruto)) return diaExiste(bruto) ? bruto : null;

  const carimbo = RE_CARIMBO.exec(bruto);
  if (!carimbo) return null;
  if (!RE_OFFSET.test(bruto)) return diaExiste(carimbo[1]!) ? carimbo[1]! : null;

  // O texto do Postgres vem com espaço e offset curto (`+00`); o `Date` do JS
  // só aceita `T` e offset com minutos.
  const instante = new Date(bruto.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(instante.getTime()) ? null : diaLocalISO(instante, fuso);
}

/** Hoje, no relógio da organização. */
export function hojeNoFuso(agora: Date, fuso: string): string {
  return diaLocalISO(agora, fuso);
}

/** `chave` mais `n` dias (ou menos). Conta em UTC: não depende do fuso do processo. */
export function somaDias(chave: string, n: number): string {
  const [ano, mes, dia] = chave.split("-").map(Number);
  return new Date(Date.UTC(ano!, mes! - 1, dia! + n)).toISOString().slice(0, 10);
}

/** O instante UTC da meia-noite da chave. Só para `Intl` com `timeZone: "UTC"`. */
export function dataUtcDaChave(chave: string): Date {
  const [ano, mes, dia] = chave.split("-").map(Number);
  return new Date(Date.UTC(ano!, mes! - 1, dia!));
}

/** O dia 1 do mês da chave, `meses` à frente (ou atrás). */
export function primeiroDoMes(chave: string, meses = 0): string {
  const [ano, mes] = chave.split("-").map(Number);
  return new Date(Date.UTC(ano!, mes! - 1 + meses, 1)).toISOString().slice(0, 10);
}

/**
 * Teto do intervalo entre dois campos, em dias. Sem teto, um contrato vencendo
 * em 2040 encheria a grade com o mesmo negócio. Passando disso, o negócio fica
 * só no dia do campo inicial. (Do upstream.)
 */
const LIMITE_DO_INTERVALO = 366;

/**
 * Os dias em que o negócio aparece: o do campo inicial e, com um segundo campo
 * coerente, todos os dias do intervalo. Fim ANTES do início é dado errado, não
 * intervalo: vale só o dia do início.
 */
export function diasDoNegocio(
  lead: Lead,
  campo: string,
  campoFim: string | null | undefined,
  fuso: string,
): string[] {
  const inicio = diaDe(valorDoCampo(lead, campo), fuso);
  if (!inicio) return [];
  if (!campoFim || campoFim === campo) return [inicio];

  const fim = diaDe(valorDoCampo(lead, campoFim), fuso);
  if (!fim || fim < inicio) return [inicio];

  const dias: string[] = [];
  for (let dia = inicio; dia <= fim; dia = somaDias(dia, 1)) {
    if (dias.length === LIMITE_DO_INTERVALO) return [inicio];
    dias.push(dia);
  }
  return dias;
}

export interface NegociosNoCalendario {
  /** Dia → negócios que aparecem nele, na ordem da lista do funil. */
  porDia: Map<string, Lead[]>;
  /** Quem não tem data válida no campo escolhido. Não some: a tela lista. */
  semData: Lead[];
}

/** Uma passada só sobre a lista: quem cai em que dia, e quem não tem dia. */
export function negociosNoCalendario(
  leads: readonly Lead[],
  campo: string,
  campoFim: string | null | undefined,
  fuso: string,
): NegociosNoCalendario {
  const porDia = new Map<string, Lead[]>();
  const semData: Lead[] = [];
  for (const lead of leads) {
    const dias = diasDoNegocio(lead, campo, campoFim, fuso);
    if (dias.length === 0) semData.push(lead);
    for (const dia of dias) {
      const doDia = porDia.get(dia);
      if (doDia) doDia.push(lead);
      else porDia.set(dia, [lead]);
    }
  }
  return { porDia, semData };
}

/**
 * O mês da chave em grade de 7 colunas, começando no DOMINGO: o mesmo desenho
 * do calendário de Tarefas e da Agenda (`weekStartsOn: 0`). `null` preenche o
 * que sobra antes e depois do mês.
 */
export function gradeDoMes(chave: string): (string | null)[] {
  const primeiro = primeiroDoMes(chave);
  const proximo = primeiroDoMes(chave, 1);
  const grade: (string | null)[] = Array<string | null>(dataUtcDaChave(primeiro).getUTCDay()).fill(null);
  for (let dia = primeiro; dia < proximo; dia = somaDias(dia, 1)) grade.push(dia);
  while (grade.length % 7 !== 0) grade.push(null);
  return grade;
}

/** Os 7 dias da semana que contém a chave, domingo primeiro. */
export function diasDaSemana(chave: string): string[] {
  const domingo = somaDias(chave, -dataUtcDaChave(chave).getUTCDay());
  return Array.from({ length: 7 }, (_, i) => somaDias(domingo, i));
}
