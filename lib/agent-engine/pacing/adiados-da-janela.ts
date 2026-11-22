/**
 * O TURNO ADIADO PELA JANELA DE RESPOSTA NÃO DORME DEPOIS QUE ELA ABRE.
 *
 * Porte de melgarafael/DeskcommCRM #3419 (issue #3383 de lá).
 *
 * O contato escreve às 22h11 com a janela de resposta 7h–22h: `inbound-turn.ts`
 * adia o job para as 7h (correto). Se a clínica abre a janela (0h–24h) no
 * meio-tempo, nada relia a mudança para quem já estava na fila: o job seguia
 * até as 7h, e a mensagem seguinte do mesmo contato entrava de carona nele.
 *
 * 1. Rastro (`adiadoPorJanela`): `rescheduleJob` grava no MESMO job a chave
 *    `adiado_por_janela`. Sem ela não dá para distinguir quem espera a ABERTURA
 *    de quem espera o debounce de rajada, cap, saldo ou sessão.
 * 2. Leitura (`janelaDeRespostaAberta`): a régua do motor, sem reimplementar.
 * 3. Acordar: `run_after = now()` na MESMA linha pendente e futura. Nunca
 *    `insert`; a segunda chamada não acha nada (idempotente), e job `running`
 *    não é re-armado.
 *
 * Quem usa: o drain (antes da carona) e o `PUT /api/v1/ai/pacing`.
 */
import type { Logger } from '../obs/logger';
import type { Queryable } from '../queue/queue';

import { janelaDeEnvioAberta } from './engine';
import { loadChannelKnobs } from './store';

export const CHAVE_ADIADO_POR_JANELA = 'adiado_por_janela';

export interface AdiadoPorJanela {
  /** `resposta` lê `resposta*`; `disparo` (retomada) lê `window*`. */
  tipo: 'resposta' | 'disparo';
  /** A abertura calculada pelo motor. */
  abertura: string;
  /** A janela que adiou (`7h-22h`), para o log. */
  janela: string;
}

export function adiadoPorJanela(info: AdiadoPorJanela): Record<string, unknown> {
  return { [CHAVE_ADIADO_POR_JANELA]: info };
}

/** `true` só para o rastro com `tipo: 'resposta'`. */
export function adiadoPelaJanelaDeResposta(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const rastro = (payload as Record<string, unknown>)[CHAVE_ADIADO_POR_JANELA];
  if (rastro === null || typeof rastro !== 'object') return false;
  return (rastro as Record<string, unknown>).tipo === 'resposta';
}

/** Pendente, futuro, fora de hold (session-watchdog) e com o rastro. */
const PREDICADO = `status = 'pending'
     and run_after > now()
     and not (payload ? 'held_run_after')
     and payload -> 'adiado_por_janela' ->> 'tipo' = 'resposta'`;

/** A janela de RESPOSTA está aberta agora? Falha de leitura = `false` (comportamento de antes). */
export async function janelaDeRespostaAberta(
  db: Queryable,
  alvo: { organizationId: string; channelSessionId: string; agora?: Date; log?: Logger },
): Promise<boolean> {
  try {
    const { knobs } = await loadChannelKnobs(db, alvo.organizationId, alvo.channelSessionId, alvo.log);
    return janelaDeEnvioAberta(alvo.agora ?? new Date(), knobs, true);
  } catch (err) {
    alvo.log?.warn('adiados da janela: leitura da janela de resposta falhou — mantendo o comportamento de antes', {
      organization_id: alvo.organizationId,
      channel_session_id: alvo.channelSessionId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return false;
  }
}

/** Acorda UM job (caminho do drain). `true` só se a linha estava pendente e futura. */
export async function soltarAdiadoPelaJanela(db: Queryable, organizationId: string, jobId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `update job_queue set run_after = now()
      where organization_id = $1 and id = $2 and ${PREDICADO}
      returning id`,
    [organizationId, jobId],
  );
  return rows.length > 0;
}

/** Acorda todos os adiados da conexão se a janela de resposta está aberta (caminho do PUT). */
export async function soltarAdiadosDaSessao(
  db: Queryable,
  alvo: { organizationId: string; channelSessionId: string; agora?: Date; log?: Logger },
): Promise<number> {
  if (!(await janelaDeRespostaAberta(db, alvo))) return 0;
  const { rowCount } = await db.query(
    `update job_queue set run_after = now()
      where organization_id = $1 and payload ->> 'channel_session_id' = $2 and ${PREDICADO}`,
    [alvo.organizationId, alvo.channelSessionId],
  );
  return rowCount ?? 0;
}
