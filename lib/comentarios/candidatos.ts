/**
 * Quais palavras oferecer ao dono para ele liberar.
 *
 * A fonte é a fila: os comentários que ELE respondeu com o próprio dedo
 * (`situacao = 'respondido_manualmente'`). Descartados não entram, e é essa
 * diferença que dá o sinal.
 *
 * Palavra de gatilho NUNCA é oferecida: oferecê-la seria pedir ao dono que
 * desarme a própria proteção num momento em que ele está apenas limpando a fila.
 *
 * Puro: recebe os textos e o que já foi decidido, devolve a lista. Quem
 * consulta o banco é a rota.
 */
import { ehTokenConhecido, ehTokenDeGatilho, tokensParaAnalise } from "./seguranca";

export interface Candidato {
  palavra: string;
  /** Em quantos COMENTÁRIOS a palavra apareceu, não quantas vezes ao todo. */
  vezes: number;
}

export function candidatosDoHistorico(
  textosRespondidos: readonly string[],
  jaDecididas: ReadonlySet<string>,
): Candidato[] {
  const contagem = new Map<string, number>();

  for (const texto of textosRespondidos) {
    // Set por comentário: "didatico didatico" conta UM comentário, não dois.
    const noComentario = new Set(tokensParaAnalise(texto));
    for (const token of noComentario) {
      if (ehTokenConhecido(token)) continue;
      if (ehTokenDeGatilho(token)) continue;
      if (jaDecididas.has(token)) continue;
      contagem.set(token, (contagem.get(token) ?? 0) + 1);
    }
  }

  return [...contagem.entries()]
    .map(([palavra, vezes]) => ({ palavra, vezes }))
    .sort((a, b) => b.vezes - a.vezes || a.palavra.localeCompare(b.palavra));
}
