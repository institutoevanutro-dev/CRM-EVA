import { esperaDaConversa } from "@/lib/inbox/comando-da-conversa";

/**
 * Os limites da cor do tempo de espera na lista do Inbox (Design 2, I5).
 *
 * Até `atencao` minutos o tempo sai em cinza de apoio; de `atencao` a `alerta`,
 * em `text-warning-fg`; acima de `alerta`, em `text-error-fg`. Os números são do
 * dono do produto e podem mudar: mudam AQUI, e só aqui.
 */
export const LIMITES_DA_ESPERA_MIN = { atencao: 15, alerta: 60 } as const;

export type FaixaDaEspera = "normal" | "atencao" | "alerta";

export interface Espera {
  /** ISO do instante em que a espera começou (a régua da Fila). */
  desde: string;
  minutos: number;
  faixa: FaixaDaEspera;
}

/**
 * O cliente está ESPERANDO resposta? E desde quando?
 *
 * Esperar = a última mensagem do cliente é mais nova que a última mensagem que
 * saiu (de pessoa ou do automático), e a conversa não está encerrada. Não há
 * coluna "esperando": `awaiting_since` (migration 0290) não volta a `null`
 * quando alguém responde — ela passa a carregar `last_inbound_at` —, então quem
 * diz "ainda sem resposta" é a comparação entre `last_inbound_at` e
 * `last_outbound_at`. O "desde quando" é `esperaDaConversa`, a mesma régua que
 * ordena e numera a Fila, para a cor não contradizer a posição "1º/2º".
 *
 * Conversa respondida devolve `null`: ela não ganha cor de alerta.
 */
export function esperaSemResposta(
  c: {
    status?: string | null;
    awaiting_since?: string | null;
    last_inbound_at?: string | null;
    last_outbound_at?: string | null;
    created_at?: string | null;
  },
  agora: number = Date.now(),
): Espera | null {
  if (c.status === "closed" || !c.last_inbound_at) return null;
  if (c.last_outbound_at && Date.parse(c.last_outbound_at) >= Date.parse(c.last_inbound_at)) return null;
  const desde = esperaDaConversa(c);
  if (!desde) return null;
  const minutos = Math.max(0, Math.floor((agora - Date.parse(desde)) / 60_000));
  const faixa: FaixaDaEspera =
    minutos > LIMITES_DA_ESPERA_MIN.alerta
      ? "alerta"
      : minutos >= LIMITES_DA_ESPERA_MIN.atencao
        ? "atencao"
        : "normal";
  return { desde, minutos, faixa };
}

/** "3 min", "2 h", "4 d" — curto para caber ao lado do nome; igual em pt e es. */
export function tempoCurtoDaEspera(minutos: number): string {
  if (minutos < 60) return `${Math.max(1, minutos)} min`;
  if (minutos < 60 * 24) return `${Math.floor(minutos / 60)} h`;
  return `${Math.floor(minutos / (60 * 24))} d`;
}
