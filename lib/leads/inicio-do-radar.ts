/**
 * O INÍCIO DO RADAR — o instante a partir do qual o radar de risco conta.
 *
 * Gravado em `organizations.settings.radar.desde` por
 * `fn_definir_inicio_do_radar` (migration 0370), pela rota
 * `app/api/v1/leads/at-risk/recomeco`. Ausente = o radar conta tudo, como
 * sempre contou.
 *
 * A regra é uma só para negócios e demandas: um item fica no radar se teve
 * ALGUMA atividade a partir do instante. Quem só tem atividade antes sai; quem
 * ganha atividade nova (o paciente escreveu, alguém mexeu no negócio) volta.
 * Nada é apagado nem alterado, e desfazer é limpar a chave.
 */

/** `settings.radar` cru → o instante (ISO) ou `null`. Forma estranha vale ausência. */
export function lerInicioDoRadar(radar: unknown): string | null {
  if (typeof radar !== "object" || radar === null) return null;
  const desde = (radar as { desde?: unknown }).desde;
  if (typeof desde !== "string" || Number.isNaN(Date.parse(desde))) return null;
  return desde;
}

/**
 * Teve atividade a partir do recomeço? `desde` nulo = não houve recomeço, e
 * tudo conta. Instante ausente ou ilegível não conta como atividade.
 */
export function ativoDesdeORecomeco(
  desde: string | null,
  atividades: ReadonlyArray<string | null | undefined>,
): boolean {
  if (desde === null) return true;
  const corte = Date.parse(desde);
  return atividades.some((a) => typeof a === "string" && Date.parse(a) >= corte);
}
