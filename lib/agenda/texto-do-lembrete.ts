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
