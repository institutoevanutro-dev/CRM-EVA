/**
 * O PERFIL DE VOZ — a amostra do "jeito dele" que autoriza a IA a publicar
 * sozinha um comentário seguro (Task 7, worker de comentários).
 *
 * Puro determinístico, igual a `seguranca.ts`: nenhuma chamada a modelo aqui.
 * A entrada é a lista de respostas PÚBLICAS que o próprio dono já deu, pelo
 * app/site do Instagram (não por este CRM), aos comentários da própria conta
 * — `admin.respostasAnterioresDoDono` é quem sabe buscar isso (Graph, na
 * implementação real de `workers/comentarios-worker.ts`).
 *
 * `sessionId: null` (comentário sem `channel_session_id` — a FK é
 * `on delete set null`) devolve `null` SEM perguntar nada ao admin: não há
 * sessão para perguntar "o jeito de quem". Zero histórico é o mesmo
 * `null` — escrever "no jeito dele" sem amostra nenhuma é o risco que esta
 * função existe para vetar; sem perfil, o worker (Task 7) cai em
 * `esperando_voce` em vez de publicar sozinho.
 */

export interface AdminDaVoz {
  respostasAnterioresDoDono(sessionId: string): Promise<string[]>;
}

export interface PerfilDeVoz {
  /** Emoji mais usados nas respostas, mais frequente primeiro. */
  emojis: string[];
  /** Tratamento predominante — "você" ou "senhor". "você" no empate/ausência (mais comum, mais informal). */
  tratamento: "você" | "senhor";
  /** Até 20 respostas típicas, na ordem em que vieram. */
  frases: string[];
}

const MAX_FRASES = 20;

/** Emoji "de verdade" — mesma classe de `lib/comentarios/seguranca.ts` (inclui variation selector e ZWJ). */
const EMOJI_RE = /\p{Extended_Pictographic}\u{FE0F}?/gu;

function emojisMaisUsados(respostas: string[]): string[] {
  const contagem = new Map<string, number>();
  for (const texto of respostas) {
    for (const emoji of texto.match(EMOJI_RE) ?? []) {
      contagem.set(emoji, (contagem.get(emoji) ?? 0) + 1);
    }
  }
  return [...contagem.entries()].sort((a, b) => b[1] - a[1]).map(([emoji]) => emoji);
}

function tratamentoPredominante(respostas: string[]): "você" | "senhor" {
  const texto = respostas.join(" ").toLowerCase();
  const senhor = (texto.match(/\bsenhor(a)?\b/gu) ?? []).length;
  const voce = (texto.match(/\bvoc[eê]\b/gu) ?? []).length;
  return senhor > voce ? "senhor" : "você";
}

export async function perfilDeVoz(admin: AdminDaVoz, sessionId: string | null): Promise<PerfilDeVoz | null> {
  if (!sessionId) return null;

  const respostas = await admin.respostasAnterioresDoDono(sessionId);
  if (respostas.length === 0) return null;

  return {
    emojis: emojisMaisUsados(respostas),
    tratamento: tratamentoPredominante(respostas),
    frases: respostas.slice(0, MAX_FRASES),
  };
}
