/**
 * AS TRÊS TRAVAS DA RESPOSTA PRONTA — puras: sem banco, sem rede, sem relógio.
 *
 * Spec EvaLink 2026-10-03 ("Respostas prontas antes da IA"): só responde pronto
 * quando as TRÊS passam; falhou uma, a mensagem segue para a IA como hoje. Errar
 * com confiança em clínica é o pior caso, então cada ambiguidade aqui resolve
 * para "não casa" — perder um acerto custa uma chamada de modelo barato; acertar
 * errado custa um paciente com a resposta de outra pergunta.
 *
 * Quem usa: o motor (`lib/agent-engine/agent/resposta-pronta.ts`), a API (para
 * embedar as formas de perguntar com o MESMO recorte de texto da mensagem) e o
 * script que grava as similaridades do corpus (Tarefa 3 do plano).
 */
import { normalizarTexto } from "@/lib/opt-out/deteccao";

/** Trava 1 — padrão conservador; a clínica ajusta entre o mínimo e o máximo. */
export const LIMITE_PADRAO = 0.82;
export const LIMITE_MINIMO = 0.78;
export const LIMITE_MAXIMO = 0.95;
/**
 * Trava 2 — outro item é "perto demais" quando a similaridade dele é >= este
 * piso E >= (melhor - MARGEM_OUTRO_ITEM), com folga de 1e-9 contra erro de ponto flutuante. Relativa de propósito: itens irmãos
 * (preço da limpeza vs. do clareamento) ficam ~0,75 numa pergunta de preço cujo
 * melhor é ~0,88; um corte absoluto em 0,70 mandaria toda pergunta de preço para
 * a IA. Mistura de assuntos na mesma mensagem também é pega pela trava 3. Fixos
 * no código: por clínica, abriria combinação insegura com o limite da trava 1.
 */
export const LIMITE_OUTRO_ITEM = 0.7;
export const MARGEM_OUTRO_ITEM = 0.06;
/** Trava 3 — caracteres, contados depois de tirar a saudação. */
export const TAMANHO_MAXIMO = 120;

const SAUDACAO =
  /^\s*(?:(?:oi+|ol[áa]|opa|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|tudo\s+bom|td\s+bem|e\s+a[íi])(?=[\s,.!?;:]|$)[\s,.!?;:]*)+/iu;

/** Orações que não são assunto: polidez e vocativo. */
const POLIDEZ: ReadonlySet<string> = new Set([
  "por favor",
  "muito obrigado",
  "muito obrigada",
  "obrigado doutor",
  "obrigada doutora",
]);

/**
 * O texto que é comparado: tudo que o cliente disse desde a nossa última
 * resposta (a rajada que o drain coalesce num job só), cada mensagem sem a
 * saudação do começo. A saudação não é o assunto e só puxaria a similaridade
 * para baixo.
 */
export function textoParaComparar(pendentes: readonly string[]): string {
  return pendentes
    .map((t) => t.trim().replace(SAUDACAO, "").trim())
    .filter((t) => t !== "")
    .join("\n");
}

export type FormaDaMensagem =
  | { ok: true }
  | { ok: false; motivo: "vazia" | "mensagem_longa" | "mais_de_uma_pergunta" | "mais_de_um_assunto" };

/**
 * Trava 3. "No máximo uma pergunta" é lido de dois jeitos, e os dois reprovam:
 * mais de um `?`, ou mais de uma oração com assunto (separada por pontuação ou
 * por " e " / " ou "). Conservador de propósito: "quanto custa a limpeza e a
 * restauração?" também vai para a IA.
 */
export function umAssuntoSo(texto: string): FormaDaMensagem {
  const t = texto.trim();
  if (t === "") return { ok: false, motivo: "vazia" };
  if (t.length > TAMANHO_MAXIMO) return { ok: false, motivo: "mensagem_longa" };
  if ((t.match(/\?/g) ?? []).length > 1) return { ok: false, motivo: "mais_de_uma_pergunta" };
  const oracoes = normalizarTexto(t)
    .split(/[?!.;,\n]+|\s(?:e|ou)\s/)
    .map((o) => o.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim())
    .filter((o) => o.split(" ").length >= 2 && !POLIDEZ.has(o));
  if (oracoes.length > 1) return { ok: false, motivo: "mais_de_um_assunto" };
  return { ok: true };
}

export type DecisaoDeCasamento =
  | { casou: true; respostaProntaId: string; similaridade: number }
  | {
      casou: false;
      motivo: "sem_candidato" | "abaixo_do_limite" | "assunto_misturado";
      similaridade: number | null;
    };

/**
 * Travas 1 e 2, a partir da MELHOR similaridade de cada item (máximo entre as
 * formas de perguntar dele). Limite fora da faixa é trazido para dentro, e
 * limite inválido vira o padrão: um NaN aqui faria toda comparação dar falso e
 * "abaixo do limite" nunca disparar — casaria qualquer coisa.
 */
export function decidirRespostaPronta(
  melhorPorItem: ReadonlyMap<string, number>,
  limite: number,
): DecisaoDeCasamento {
  const corte = Number.isFinite(limite)
    ? Math.min(Math.max(limite, LIMITE_MINIMO), LIMITE_MAXIMO)
    : LIMITE_PADRAO;
  const ordenados = [...melhorPorItem]
    .filter(([, s]) => Number.isFinite(s))
    .sort((a, b) => b[1] - a[1]);
  const primeiro = ordenados[0];
  const segundo = ordenados[1];
  if (primeiro === undefined) return { casou: false, motivo: "sem_candidato", similaridade: null };
  if (primeiro[1] < corte) return { casou: false, motivo: "abaixo_do_limite", similaridade: primeiro[1] };
  if (segundo !== undefined && segundo[1] >= LIMITE_OUTRO_ITEM && primeiro[1] - segundo[1] <= MARGEM_OUTRO_ITEM + 1e-9) {
    return { casou: false, motivo: "assunto_misturado", similaridade: primeiro[1] };
  }
  return { casou: true, respostaProntaId: primeiro[0], similaridade: primeiro[1] };
}
