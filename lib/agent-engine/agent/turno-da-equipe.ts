/**
 * TURNOS QUE A IA NÃO RESPONDE: PASSAM À EQUIPE, CALADOS.
 *
 * O roteador (`resolve-turn-agent.ts`) decide; aqui só se executa a decisão,
 * pelo MESMO caminho do robô do outro lado (`performHumanHandoff` sem avisar o
 * contato): `force_human`, `bot_silenced_until='infinity'`, follow-ups
 * cancelados e UM aviso na Central. Antes de qualquer modelo de atendimento,
 * então nenhum token e nenhum envio. O `stopGate` do before-send veta o resto.
 *
 *   - `bloqueado_apos_equipe`: a equipe já falou na conversa e o assunto (e o
 *     fallback) está em `nao_reabre_apos_equipe`.
 *   - `so_equipe`: conversa de negócio (fornecedor, parceria, vendas) ou
 *     resposta automática de outro robô (`config.so_equipe`). Nas conversas
 *     medidas no Instituto (02 e 03/11) a IA abria o caso E escrevia; a
 *     instrução no prompt não segurava. Aqui não há modelo para desobedecer.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { isLeadInHandoff, performHumanHandoff, type HandoffIds } from './human-handoff';
import type { TurnAgentResolution } from './resolve-turn-agent';

export const TITULO_DO_AVISO_DE_ASSUNTO_APOS_EQUIPE =
  'O cliente voltou a um assunto que a IA não reabre depois que a equipe falou';

export const TITULO_DO_AVISO_SO_DA_EQUIPE =
  'Conversa de negócio ou mensagem automática — a IA não respondeu. Se for cliente, use Devolver ao automático';

const PASSAGENS = {
  bloqueado_apos_equipe: {
    reason: 'assunto_nao_reabre_apos_equipe',
    inboxTitle: TITULO_DO_AVISO_DE_ASSUNTO_APOS_EQUIPE,
    conversationSummary:
      'A equipe já conversou com este contato, e o assunto da mensagem nova está na lista que a IA não reabre ' +
      'depois disso. A IA não respondeu e o contato NÃO foi avisado. Responda pela conversa.',
  },
  so_equipe: {
    reason: 'assunto_da_equipe',
    inboxTitle: TITULO_DO_AVISO_SO_DA_EQUIPE,
    conversationSummary:
      'O roteador classificou a mensagem como conversa de negócio com a empresa (fornecedor, parceria, vendas) ' +
      'ou como resposta automática de outro sistema. A IA não respondeu e o contato NÃO foi avisado. ' +
      'Se for um cliente, use "Devolver ao automático".',
  },
} as const;

/** `true` = o turno acabou aqui (passado à equipe, ou já estava com ela). */
export async function passarTurnoAEquipeSeForOCaso(
  pool: pg.Pool,
  ids: HandoffIds,
  resolucao: Pick<TurnAgentResolution, 'outcome' | 'intentName'>,
  log: Logger,
): Promise<boolean> {
  if (resolucao.outcome !== 'bloqueado_apos_equipe' && resolucao.outcome !== 'so_equipe') return false;
  const passagem = PASSAGENS[resolucao.outcome];
  // Já com a equipe: não reabrir aviso que alguém fechou.
  if (await isLeadInHandoff(pool, ids.tenantId, ids.leadId)) return true;
  await performHumanHandoff(pool, ids, { ...passagem, log });
  log.info('turno passado à equipe sem resposta da IA', { motivo: resolucao.outcome, intent: resolucao.intentName });
  return true;
}
