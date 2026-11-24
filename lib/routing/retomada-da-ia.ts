/**
 * A CONVERSA DEVOLVIDA À IA NÃO VOLTA PARA A DISTRIBUIÇÃO SÓ PORQUE PEDIRAM.
 *
 * Porte do upstream melgarafael/DeskcommCRM#5176 (contribuição de @fcostamil-hub).
 *
 * ## O defeito que isto fecha
 *
 * Com o rodízio ligado, toda conversa sem dono numa fila aberta pede
 * distribuição, e o `routing-worker` a entrega a uma pessoa em menos de um
 * minuto. A entrega grava `assignee_kind = 'user'` e o gate da IA cala o agente
 * (`conversa_de_humano`). Neste fork o pedido nasce da PRÓPRIA devolução: soltar
 * o dono dispara `trg_routing_assignment_changed`, e `fn_wake_channel_routing`
 * repete o pedido para toda conversa sem dono quando muda a disponibilidade da
 * equipe. "Devolver ao automático" era desfeito pela fila logo em seguida.
 *
 * ## A régua
 *
 * Toda devolução ao automático (`devolverAtendimentoAoAgente`) grava a marca
 * `metadata.ia_retomada` na conversa. Enquanto a marca existir E a conversa não
 * tiver passado para humano de novo (`last_handoff_at` nulo — a própria devolução
 * o limpa, e a passagem o grava) E houver IA no ar para a conversa
 * (`lerQualificacaoDaIA`), o worker GUARDA o pedido de distribuição em vez de
 * entregar.
 *
 * Não há prazo: quem decide que a conversa precisa de gente é a IA (a passagem)
 * ou uma pessoa (Assumir/Transferir) — nunca o relógio.
 *
 * ## Por que reagendar, e não descartar
 *
 * A passagem do motor nativo (`performHumanHandoff`) leva a conversa de
 * `ai_handling` para `pending` sem dono, e isso não pede distribuição por conta
 * própria. Descartar o pedido deixaria a conversa passada para humano sem
 * ninguém. Então o pedido é reagendado a cada `INTERVALO_DA_RETOMADA_MS`: na
 * primeira rodada depois da passagem, `last_handoff_at` está gravado, a marca
 * deixa de valer e a conversa é distribuída normalmente.
 *
 * ## O que NÃO muda
 *
 *  - modo manual: não há distribuição automática, a marca não é lida;
 *  - conversa com dono: o worker já sai antes (`already_assigned`);
 *  - caso que tira a conversa da fila: vale o caso;
 *  - sem IA no ar, IA pausada ou calada: distribui (falha ABERTA).
 */

/** A chave em `conversations.metadata`. */
export const CHAVE_DA_RETOMADA_DA_IA = "ia_retomada";

/** De quanto em quanto tempo o pedido guardado é reavaliado. */
export const INTERVALO_DA_RETOMADA_MS = 5 * 60_000;

export type QuemDevolveu = "pessoa" | "automatica";

export interface MarcaDeRetomada {
  /** Instante ISO da devolução. */
  em: string;
  por: QuemDevolveu;
}

/** A marca que a devolução grava. */
export function marcaDeRetomada(por: QuemDevolveu, agora: Date): MarcaDeRetomada {
  return { em: agora.toISOString(), por };
}

/** Lê a marca sem confiar na forma do `metadata` (jsonb livre). */
export function lerMarcaDeRetomada(metadata: unknown): MarcaDeRetomada | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruta = (metadata as Record<string, unknown>)[CHAVE_DA_RETOMADA_DA_IA];
  if (!bruta || typeof bruta !== "object") return null;
  const { em, por } = bruta as Record<string, unknown>;
  if (typeof em !== "string" || !Number.isFinite(Date.parse(em))) return null;
  if (por !== "pessoa" && por !== "automatica") return null;
  return { em, por };
}

export interface EntradaDaRetomada {
  metadata: unknown;
  /** `conversations.last_handoff_at`: gravado = a conversa passou para humano depois da devolução. */
  lastHandoffAt: string | null;
  /** A IA está no ar para esta conversa e livre para atender (`lerQualificacaoDaIA`). */
  iaAtendendo: boolean;
  agora: Date;
}

/**
 * Até quando o pedido de distribuição fica guardado (ISO), ou `null` = distribuir
 * pelo caminho de sempre.
 */
export function esperaPelaRetomada(e: EntradaDaRetomada): string | null {
  if (!lerMarcaDeRetomada(e.metadata)) return null;
  if (e.lastHandoffAt !== null) return null;
  if (!e.iaAtendendo) return null;
  return new Date(e.agora.getTime() + INTERVALO_DA_RETOMADA_MS).toISOString();
}
