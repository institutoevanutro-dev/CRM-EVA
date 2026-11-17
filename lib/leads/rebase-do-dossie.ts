/**
 * O DOSSIÊ ACOMPANHA O LEAD VIVO SEM DESFAZER QUEM GRAVOU POR FORA
 * (auditoria L4, achado 6).
 *
 * O formulário do dossiê (`LeadFieldsForm`) carregava o lead ao abrir e, ao
 * salvar, mandava TODOS os campos de cima — título, descrição, valor, data,
 * etiquetas — com o valor que tinha na tela. O lead é vivo (realtime): o que a
 * IA (MCP `crm_update_lead`) ou um colega gravava com o dossiê aberto aparecia
 * no cabeçalho e era desfeito pelo Salvar de quem nem tocou naquele campo.
 *
 * A régua é a de um merge de três pontas, campo a campo:
 *   - `base`     o que o formulário viu do servidor da última vez;
 *   - `atual`    o que está na tela agora;
 *   - `servidor` o lead que acabou de chegar.
 * Campo que a pessoa não mexeu (`atual == base`) acompanha o servidor; campo
 * que ela mexeu fica com ela. E o Salvar só manda o que difere da `base`.
 *
 * `custom_fields` segue por `soChavesAlteradas` + `fn_lead_anotar_campos`
 * (merge por chave, atômico, no servidor). As etiquetas são um CONJUNTO: o que
 * a pessoa acrescentou e tirou é aplicado sobre o conjunto do servidor, e a
 * etiqueta que a IA acrescentou no meio não some.
 */
import { igual } from "./custom-fields-so-diff";

/** Campo a campo: o não mexido acompanha o servidor; o mexido fica. */
export function rebaseCampos<T extends Record<string, unknown>>(
  base: T,
  atual: T,
  servidor: T,
): T {
  const saida = { ...servidor };
  for (const chave of Object.keys(atual) as (keyof T)[]) {
    if (!igual(atual[chave], base[chave])) saida[chave] = atual[chave];
  }
  return saida;
}

/** O que mudou em relação à base — só isso viaja no Salvar. */
export function camposMexidos<T extends Record<string, unknown>>(base: T, atual: T): Partial<T> {
  const saida: Partial<T> = {};
  for (const chave of Object.keys(atual) as (keyof T)[]) {
    if (!igual(atual[chave], base[chave])) saida[chave] = atual[chave];
  }
  return saida;
}

/**
 * As etiquetas de quem edita aplicadas sobre as do servidor: as acrescentadas
 * entram, as tiradas saem, as que o servidor ganhou no meio ficam.
 */
export function mesclarEtiquetas(
  base: readonly string[],
  atual: readonly string[],
  servidor: readonly string[],
): string[] {
  const tiradas = new Set(base.filter((t) => !atual.includes(t)));
  const acrescentadas = atual.filter((t) => !base.includes(t));
  const saida = servidor.filter((t) => !tiradas.has(t));
  for (const t of acrescentadas) if (!saida.includes(t)) saida.push(t);
  return saida;
}

export function mesmasEtiquetas(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}
