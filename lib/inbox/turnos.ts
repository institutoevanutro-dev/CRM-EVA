import type { Message } from "@/lib/types/messaging";

/**
 * TURNOS DA CONVERSA (I8) — onde começa e onde termina cada sequência.
 *
 * Mensagens seguidas da MESMA voz, com até 5 min entre uma e a próxima, são um
 * turno: o rótulo de quem falou aparece só na primeira bolha e a ponta só na
 * última. "Mesma voz" é mesma direção, mesma origem (`sent_via`) e mesmo autor:
 * a pessoa da equipe (`sent_by_user_id`) ou, no automático, o agente gravado
 * (`ai_actor_name`) — e a resposta pronta é voz própria, porque tem rótulo
 * próprio. Qualquer outra coisa no meio (uma nota interna) quebra o turno.
 */
export const INTERVALO_DO_TURNO_MS = 5 * 60_000;

export type PosicaoNoTurno = { inicio: boolean; fim: boolean };

function voz(m: Message): string {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  return [
    m.direction,
    m.sent_via ?? "",
    m.sent_by_user_id ?? "",
    typeof meta.ai_actor_name === "string" ? meta.ai_actor_name.trim() : "",
    typeof meta.resposta_pronta_id === "string" ? "pronta" : "",
  ].join("|");
}

function continua(anterior: Message, atual: Message): boolean {
  const intervalo = Date.parse(atual.sent_at) - Date.parse(anterior.sent_at);
  return voz(anterior) === voz(atual) && intervalo >= 0 && intervalo <= INTERVALO_DO_TURNO_MS;
}

/**
 * Recebe a sequência na ordem da tela (`null` = item que não é mensagem, como
 * a nota interna) e devolve a posição de cada mensagem no seu turno, por id.
 */
export function posicoesNoTurno(itens: ReadonlyArray<Message | null>): Map<string, PosicaoNoTurno> {
  const saida = new Map<string, PosicaoNoTurno>();
  itens.forEach((m, i) => {
    if (!m) return;
    const antes = itens[i - 1];
    const depois = itens[i + 1];
    saida.set(m.id, {
      inicio: !(antes && continua(antes, m)),
      fim: !(depois && continua(m, depois)),
    });
  });
  return saida;
}
