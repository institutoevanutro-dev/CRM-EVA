/**
 * O rótulo de quem atende, num lugar só para as telas que precisam dele
 * (porte do original #3298, issue #3023 lá).
 *
 * Membro sem `full_name` (perfil antigo, convite não completado, instalação sem
 * a chave de serviço) aparecia como `Atendente 4fa3a91c`, os oito primeiros
 * dígitos do `user_id`, no seletor de transferência e na menção da nota interna,
 * onde o código ia GRAVADO no corpo e virava o texto da notificação. O id não é
 * nome de ninguém. Sem nome, o rótulo é o mesmo em toda tela e todo render; o id
 * segue só no token da menção, que é o que faz a notificação chegar à pessoa.
 *
 * Não cai para e-mail de propósito: seria o único dado que distingue dois
 * atendentes sem nome, mas é dado pessoal, e expô-lo para a organização inteira
 * (e dentro do corpo da nota) é decisão de LGPD, não de rótulo de tela.
 */

/** A chave i18n do rótulo; `lib/i18n/dicionario.ts` já a traduz. */
export const ROTULO_ATENDENTE_SEM_NOME = "Atendente sem nome";

/** O `t` do `useT()`: chave em português → texto no idioma de quem lê. */
export type Tradutor = (texto: string) => string;

/** O nome cadastrado, ou o rótulo único de quem não tem nome (em branco conta como sem). */
export function rotuloDoAtendente(full_name: string | null | undefined, t: Tradutor): string {
  return full_name?.trim() || t(ROTULO_ATENDENTE_SEM_NOME);
}
