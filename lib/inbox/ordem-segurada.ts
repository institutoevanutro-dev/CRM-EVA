/**
 * A ORDEM DA LISTA FICA PARADA SOB O MOUSE (item 40 da auditoria de 17/11).
 *
 * Cada mensagem nova reordenava a lista na hora: a conversa sob o mouse pulava
 * e o clique caía em outra — a pessoa errada. Enquanto o mouse está sobre a
 * lista, a ordem é a da hora em que ele entrou (`congelada`):
 *
 *  - quem já estava fica no mesmo lugar, com os dados novos (prévia, hora);
 *  - quem some (fechada, assumida por outro) sai;
 *  - quem chega ACIMA do último conhecido (mensagem nova sobe ao topo) espera,
 *    e entra na conta das novidades;
 *  - quem chega DEPOIS do último conhecido ("Carregar mais", a Fila que cresce
 *    pelo fim) entra no fim: ali não empurra ninguém para baixo do mouse.
 *
 * `novidades` conta as que esperam mais as que subiriam de lugar: é o número do
 * aviso "N conversas com novidade ↑", que solta a ordem num clique.
 */
export function ordemSegurada<T extends { id: string }>(
  itens: readonly T[],
  congelada: readonly string[] | null,
): { exibidos: T[]; novidades: number } {
  if (!congelada) return { exibidos: [...itens], novidades: 0 };
  const posicaoCongelada = new Map(congelada.map((id, i) => [id, i]));
  let ultimoConhecido = -1;
  itens.forEach((item, i) => {
    if (posicaoCongelada.has(item.id)) ultimoConhecido = i;
  });

  const conhecidos = itens.filter((item) => posicaoCongelada.has(item.id));
  const naOrdemCongelada = [...conhecidos].sort(
    (a, b) => posicaoCongelada.get(a.id)! - posicaoCongelada.get(b.id)!,
  );
  const retidos = itens.filter((item, i) => !posicaoCongelada.has(item.id) && i < ultimoConhecido);
  const noFim = itens.filter((item, i) => !posicaoCongelada.has(item.id) && i > ultimoConhecido);

  // Subiu quem está, na ordem nova, antes de onde estava entre os conhecidos.
  const subiram = conhecidos.filter((item, rankNovo) => rankNovo < naOrdemCongelada.indexOf(item)).length;

  return { exibidos: [...naOrdemCongelada, ...noFim], novidades: retidos.length + subiram };
}
