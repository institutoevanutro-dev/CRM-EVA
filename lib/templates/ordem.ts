/**
 * A ORDEM DA RESPOSTA RÁPIDA, a conta que a rota usa (porte do original #3261).
 *
 * A tela manda em que resposta o operador soltou (`depois_de`, o vizinho da
 * ESQUERDA; `null` = primeira da lista), e a posição sai da média entre esse
 * vizinho e o seguinte: o mesmo `midpoint` do quadro (`lib/kanban/
 * fractional-indexing.ts`). Só a linha arrastada é escrita, e é isso que faz a
 * reordenação conviver com a RLS: quem escreve a própria resposta pessoal não
 * escreve a compartilhada.
 *
 * Duas respostas ainda podem dividir a MESMA posição (duas criações ao mesmo
 * tempo leem a mesma primeira), e a média entre duas que só diferem no último
 * bit do double não cabe entre elas. Nesses casos `posicaoEntre` devolve `null`
 * e quem chama RENUMERA a lista visível, em vez de gravar `NaN` ou um número
 * igual ao do vizinho, que deixariam a linha fora do lugar onde foi solta.
 */
import { midpoint } from "@/lib/kanban/fractional-indexing";

/** A posição entre `anterior` e `proxima`, ou `null` quando não há posição representável. */
export function posicaoEntre(anterior: number | null, proxima: number | null): number | null {
  const media = midpoint(anterior, proxima);
  if (anterior !== null && proxima !== null && !(media > anterior && media < proxima)) return null;
  return media;
}

/** A posição do índice `i` na lista renumerada: passos de 1000 a partir de 1000, como no quadro. */
export function ordemDaRenumeracao(indice: number): number {
  return (indice + 1) * 1000;
}
