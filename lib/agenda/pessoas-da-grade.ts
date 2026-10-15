/**
 * Quais profissionais a pessoa escolheu ver na grade da Agenda, guardado no
 * navegador dela.
 *
 * `localStorage`, como a visão do funil (`lib/kanban/visao-do-funil.ts`): é
 * preferência de quem olha, não dado do negócio. A chave leva o id de quem está
 * logado, porque a recepção costuma dividir o mesmo computador. Sem
 * armazenamento (aba anônima, bloqueio do site) a escolha vale só nesta visita,
 * e nada lança.
 *
 * O que volta daqui é só um PEDIDO: quem lê cruza com as pessoas que o servidor
 * devolveu (`selecaoValida`), e id que a pessoa não enxerga hoje some sozinho.
 */
const PREFIXO = "agenda.pessoas.v1:";

export function lerPessoasDaGrade(usuarioId: string): string[] {
  try {
    const dado: unknown = JSON.parse(window.localStorage.getItem(PREFIXO + usuarioId) ?? "[]");
    return Array.isArray(dado) ? dado.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function gravarPessoasDaGrade(usuarioId: string, ids: readonly string[]): void {
  try {
    if (ids.length === 0) window.localStorage.removeItem(PREFIXO + usuarioId);
    else window.localStorage.setItem(PREFIXO + usuarioId, JSON.stringify(ids));
  } catch {
    // Sem persistência a escolha vale nesta visita.
  }
}

/** A seleção que ainda vale: só quem está na lista de pessoas que o servidor devolveu. */
export function selecaoValida(
  selecionadas: readonly string[],
  pessoas: ReadonlyArray<{ id: string }>,
): string[] {
  return selecionadas.filter((id) => pessoas.some((p) => p.id === id));
}
