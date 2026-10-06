/**
 * O TEXTO DO LEMBRETE DO COMPROMISSO — as variáveis, a validação e a frase.
 *
 * Uma lista só de variáveis, lida por três lugares que não podem divergir: a
 * validação do PATCH do tipo (`app/api/v1/agenda/tipos/route.ts`), a ajuda e a
 * prévia da tela (`app/app/settings/tenant/agenda/_client.tsx`) e o cron que
 * manda (`app/api/v1/cron/agenda-reminder/route.ts`).
 *
 * ⚠️ PURO e sem import de servidor (`@/lib/supabase`, `@/lib/env`,
 * `@/lib/logger`): a tela importa este arquivo para a prévia.
 */

import { diaLocalISO } from "@/lib/agenda/fuso";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

/**
 * As variáveis aceitas. `titulo` e `dia` vêm do original (6146539da) e
 * continuam com o sentido de lá; as demais são deste fork. `quando` aqui é
 * "hoje"/"amanhã"/"segunda-feira, 12/10" (sem hora), divergência consciente do
 * original, onde `{{quando}}` trazia a hora junto.
 */
export const VARIAVEIS_DO_LEMBRETE = [
  "primeiro_nome",
  "nome",
  "quando",
  "data",
  "hora",
  "dia_semana",
  "unidade",
  "endereco",
  "profissional",
  "tipo",
  "titulo",
  "dia",
] as const;

export type VariavelDoLembrete = (typeof VARIAVEIS_DO_LEMBRETE)[number];

const CONHECIDAS = new Set<string>(VARIAVEIS_DO_LEMBRETE);

/** Qualquer `{{…}}` sem chave dentro — a forma que o molde reconhece. */
const VARIAVEL = /\{\{([^{}]*)\}\}/g;

/** O nome de cada `{{…}}` do molde, aparado e em minúsculas. */
export function variaveisDoMolde(molde: string): string[] {
  return [...molde.matchAll(VARIAVEL)].map((m) => (m[1] ?? "").trim().toLowerCase());
}

/**
 * O que o molde escreve como variável e não é uma.
 *
 * Duas formas de errar, e as duas chegariam CRUAS ao WhatsApp do paciente:
 * `{{…}}` com conteúdo fora da lista (`{{foo}}`, `{{primeiro nome}}`,
 * `{{primeiro-nome}}`) e chave solta que sobra depois de tirar as `{{…}}` —
 * que é o caso de `{nome}`, a forma que o documento de negócio usa.
 */
export function variaveisDesconhecidas(texto: string): string[] {
  const erradas = variaveisDoMolde(texto).filter((v) => !CONHECIDAS.has(v));
  const soltas = texto.replace(VARIAVEL, "").match(/[{}]/g) ?? [];
  return [...erradas, ...soltas];
}

/**
 * Aplica o molde (porte de 6146539da). Variável desconhecida fica literal: o
 * PATCH já a recusa, e o que sobrar aqui é dado gravado por fora da API.
 */
export function aplicarMoldeDoLembrete(molde: string, pecas: Record<string, string>): string {
  return molde.replace(VARIAVEL, (literal, raw: string) => {
    const v = pecas[raw.trim().toLowerCase()];
    return v === undefined ? literal : v;
  });
}

/**
 * A variável vazia some sem deixar rastro: espaço duplo vira um, espaço antes
 * de pontuação sai, e espaço na ponta de cada linha também. Quebra de linha
 * NUNCA é tocada — lembrete de WhatsApp costuma ter várias linhas.
 */
function limparEspacos(texto: string): string {
  return texto
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.!?])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

/** O dia civil seguinte a `YYYY-MM-DD`, somado na data e não em 24h de relógio. */
function diaSeguinte(iso: string): string {
  const [ano, mes, dia] = iso.split("-").map(Number);
  return new Date(Date.UTC(ano ?? 1970, (mes ?? 1) - 1, (dia ?? 1) + 1)).toISOString().slice(0, 10);
}

/**
 * O texto do lembrete.
 *
 * Sem molde, sai a frase padrão — o quê, quando e onde —, a mesma de antes,
 * byte a byte. Com molde (`calendar_event_types.reminder_body`), as variáveis
 * de `VARIAVEIS_DO_LEMBRETE` são preenchidas com os mesmos dados.
 *
 * O fuso é o do COMPROMISSO (`calendar_appointments.time_zone`, o fuso da
 * jornada em que o horário foi decidido), e é nele que "hoje" e "amanhã" são
 * contados: 00:30 de amanhã em São Paulo ainda é 23:30 de hoje em Manaus.
 */
export function montarLembrete(input: {
  nomeDoContato: string | null;
  titulo: string;
  quando: Date;
  timezone: string;
  local: string | null;
  /**
   * O idioma da ORGANIZAÇÃO (`organizations.locale`), e não um literal.
   *
   * `tests/unit/i18n-a-data-segue-o-idioma.test.ts` proíbe `"pt-BR"` escrito à
   * mão em formatação de data fora de `lib/i18n/datas.ts` — e o motivo não é
   * estética: uma instalação em espanhol receberia o lembrete com "jueves, 03/09"
   * no meio de uma frase em português, que é a tela meio traduzida que aquele
   * guarda existe para impedir. Aqui vale em dobro, porque isto não é tela: é
   * mensagem que sai para o WhatsApp de um cliente e não dá para desfazer.
   *
   * Opcional com o padrão do produto para a função seguir pura e testável sem
   * banco — o mesmo desenho de `montarPares` em `lib/metrics/atrito.ts`.
   */
  idioma?: Idioma;
  /** Texto próprio do tipo. Vazio/nulo = a frase padrão. */
  molde?: string | null;
  /** Nome do tipo de atendimento, para `{{tipo}}`. Cai no título se faltar. */
  tipoNome?: string | null;
  /** Nome da unidade do compromisso. Sem unidade, `{{unidade}}` fica vazia. */
  unidade?: string | null;
  /** Nome do profissional dono do compromisso. Nunca o e-mail. */
  profissional?: string | null;
  /** O relógio de "hoje"/"amanhã". Padrão: agora. */
  agora?: Date;
}): string {
  const idioma = input.idioma ?? IDIOMA_PADRAO;
  const t = (texto: string) => traduzir(texto, idioma);
  const etiqueta = tagDeIdioma(idioma);
  const formatar = (opcoes: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(etiqueta, { timeZone: input.timezone, ...opcoes }).format(input.quando);

  const dia = formatar({ weekday: "long", day: "2-digit", month: "2-digit" });
  const hora = formatar({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const nome = input.nomeDoContato?.trim() ?? "";

  const molde = input.molde?.trim();
  if (molde) {
    const hoje = diaLocalISO(input.agora ?? new Date(), input.timezone);
    const doCompromisso = diaLocalISO(input.quando, input.timezone);
    const quando = doCompromisso === hoje ? t("hoje") : doCompromisso === diaSeguinte(hoje) ? t("amanhã") : dia;
    const pecas: Record<VariavelDoLembrete, string> = {
      nome,
      primeiro_nome: nome.split(/\s+/)[0] ?? "",
      quando,
      data: formatar({ day: "2-digit", month: "2-digit" }),
      hora,
      dia_semana: formatar({ weekday: "long" }),
      unidade: input.unidade?.trim() ?? "",
      endereco: input.local?.trim() ?? "",
      profissional: input.profissional?.trim() ?? "",
      tipo: input.tipoNome?.trim() || input.titulo,
      titulo: input.titulo,
      dia,
    };
    return limparEspacos(aplicarMoldeDoLembrete(molde, pecas));
  }

  // Cada `t()` cobre só a parte FIXA da frase: nome, título, data e endereço
  // são dado do tenant e nunca passam por tradução.
  // A pontuação entra na CHAVE de propósito: em espanhol a exclamação abre a
  // frase ("¡Hola"), e um `t("Oi")` solto com o `!` colado do lado de fora
  // devolveria "Hola, Rose!" — meio traduzido, que é o defeito que o guarda de
  // i18n existe para impedir.
  const saudacao = input.nomeDoContato ? `${t("Oi,")} ${input.nomeDoContato}!` : t("Oi!");
  const onde = input.local ? ` ${t("Endereço")}: ${input.local}.` : "";
  return (
    `${saudacao} ${t("Passando pra lembrar do seu compromisso:")} ` +
    `${input.titulo}, ${dia} ${t("às")} ${hora}.${onde}`
  );
}
