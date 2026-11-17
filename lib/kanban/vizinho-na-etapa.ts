import type { Lead } from "@/lib/types/leads";
import { midpoint } from "./fractional-indexing";

/** O que a conta precisa de um card: identidade e posição na etapa. */
type CardNaEtapa = Pick<Lead, "id" | "position_in_stage">;

/**
 * O vizinho de baixo do card solto, contado na etapa INTEIRA (sem o filtro da
 * página).
 *
 * O quadro monta o `before`/`after` a partir da lista VISÍVEL — é ela que o
 * operador vê e é dela que sai o card em que ele soltou. Mas a etapa inteira é
 * maior que a visível assim que um filtro liga, e `midpoint` só continua
 * produzindo uma posição que ninguém tem se os dois vizinhos forem os
 * vizinhos REAIS: com o de baixo tirado de lista filtrada, soltar no fim dá
 * `último + 1000`, que é a posição nascida do card que o filtro escondeu, e a
 * média entre dois visíveis cai em cima do escondido do meio (issue #2545).
 *
 * Sem filtro a etapa inteira e a lista visível coincidem, e o resultado é o
 * mesmo `after` de antes.
 *
 * - `acima` nulo (solto no topo): o primeiro card da etapa inteira.
 * - Card escondido EMPATADO com o de cima (empate já gravado no banco): é
 *   pulado, senão o `midpoint` daria NaN. Empate entre dois VISÍVEIS é
 *   resolvido por `posicaoAoSoltar`, abaixo.
 * - Sem o cache do quadro, ou com o de cima fora dele: o `after` visível.
 *
 * Ordena uma CÓPIA (`filter` já devolve array novo): a lista do cache é
 * compartilhada por todo o quadro e reordená-la aqui embaralharia a coluna na
 * hora do arrasto.
 */
export function proximoNaEtapaInteira<C extends CardNaEtapa>(
  acima: C | null,
  abaixoVisivel: C | null,
  etapaInteira: readonly C[] | null,
  arrastadoId: string,
): C | null {
  if (!etapaInteira) return abaixoVisivel;
  const todos = etapaInteira
    .filter((l) => l.id !== arrastadoId)
    .sort((a, b) => a.position_in_stage - b.position_in_stage);
  if (!acima) return todos[0] ?? null;
  const i = todos.findIndex((l) => l.id === acima.id);
  if (i < 0) return abaixoVisivel;
  const empatado = (l: C) => l.position_in_stage === acima.position_in_stage;
  return todos.slice(i + 1).find((l) => l.id === abaixoVisivel?.id || !empatado(l)) ?? null;
}

/**
 * A posição do card solto — e, com EMPATE já gravado entre os dois vizinhos,
 * uma posição livre logo depois do grupo empatado em vez de nenhuma.
 *
 * Empate entre dois cards VISÍVEIS (`acima` e `abaixo` com a mesma
 * `position_in_stage`, herança de dado antigo ou de importação) não tem número
 * no meio: `midpoint` dá NaN, e o quadro cancelava o arrasto em silêncio — o
 * card voltava e ninguém dizia por quê (auditoria 16/11, achado 27). Aqui o
 * card cai depois do ÚLTIMO empatado: a ordem DENTRO do empate já era
 * indefinida (o banco não a guarda), então essa é a posição mais próxima da
 * pedida que existe. `ajustada` avisa quem chamou para dizer isso na tela.
 */
export function posicaoAoSoltar<C extends CardNaEtapa>(
  acima: C | null,
  abaixo: C | null,
  etapaInteira: readonly C[] | null,
  arrastadoId: string,
): { posicao: number; ajustada: boolean } {
  const posicao = midpoint(acima?.position_in_stage ?? null, abaixo?.position_in_stage ?? null);
  if (!Number.isNaN(posicao) || !acima) return { posicao, ajustada: false };
  const empate = acima.position_in_stage;
  const seguinte = (etapaInteira ?? [acima, ...(abaixo ? [abaixo] : [])])
    .filter((l) => l.id !== arrastadoId && l.position_in_stage > empate)
    .reduce<C | null>((menor, l) => (!menor || l.position_in_stage < menor.position_in_stage ? l : menor), null);
  return { posicao: midpoint(empate, seguinte?.position_in_stage ?? null), ajustada: true };
}
