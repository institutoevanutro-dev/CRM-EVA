/**
 * Consumidor do `event_log` que aciona a supervisão depois de uma AÇÃO HUMANA
 * concluída — o adaptador fino, no mesmo padrão de
 * `lib/followup/gatilho-etapa.handler.ts`.
 *
 * Dois eventos, os dois emitidos DEPOIS do commit da ação:
 *
 *  - `supervision.review_requested` (origem `human_message_sent`) — emitido pela
 *    rota de envio quando quem enviou é pessoa (`app/api/v1/messages/_handler.ts`).
 *  - `lead.stage_changed` com `metadata.actor_user_id` — pessoa moveu o card.
 *    Movimento com `metadata.actor_kind = 'supervisor'` é a própria supervisão:
 *    marca `originadoPorSupervisao` e o filtro corta o ciclo.
 *
 * O autor e os ids NUNCA vêm do texto do evento sozinho: são relidos no banco
 * (mensagem → conversa → contato; negócio → contato → conversa mais recente) e
 * a organização é a da LINHA do `event_log`.
 */
import type { EventHandler, EventRow, HandlerResult } from '@/lib/event-log/dispatcher';
import { getRequestPool } from '@/lib/agent-engine/db/request-pool';

import { acionarSupervisao, type FatoConcluido } from './acionamento';

export const SUPERVISAO_ACIONAMENTO_HUMANO_HANDLER_KEY = 'supervisao-acionamento-humano.v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

type Consulta = Pick<ReturnType<typeof getRequestPool>, 'query'>;

/**
 * Traduz a linha do `event_log` num fato concluído, ou `null` quando o evento
 * não é ação humana revisável. Exportada para o teste alcançar a regra sem banco
 * de verdade (recebe um `query` falso).
 */
export async function fatoHumanoDoEvento(db: Consulta, row: EventRow): Promise<FatoConcluido | null> {
  const org = row.organization_id;
  const quando = row.created_at ?? new Date().toISOString();

  if (row.event_type === 'supervision.review_requested') {
    const messageId = str(row.entity_id);
    if (messageId === null || row.payload.origin !== 'human_message_sent') return null;
    const { rows } = await db.query<{ conversation_id: string; contact_id: string; sent_by_user_id: string | null }>(
      `select conversation_id, contact_id, sent_by_user_id from messages
        where organization_id = $1 and id = $2 and direction = 'outbound'`,
      [org, messageId],
    );
    const m = rows[0];
    // Autor relido da MENSAGEM: sem `sent_by_user_id` não há pessoa a revisar.
    if (m === undefined || m.sent_by_user_id === null) return null;
    return {
      organizationId: org,
      conversationId: m.conversation_id,
      contactId: m.contact_id,
      actorType: 'user',
      actorId: m.sent_by_user_id,
      eventId: row.id,
      origin: 'human_message_sent',
      occurredAt: new Date(quando).toISOString(),
      traceId: `event_log:${row.id}`,
    };
  }

  if (row.event_type === 'lead.stage_changed') {
    const leadId = str(row.entity_id);
    const doSupervisor = row.metadata.actor_kind === 'supervisor';
    const userId = str(row.metadata.actor_user_id);
    if (leadId === null || (userId === null && !doSupervisor)) return null;
    const { rows } = await db.query<{ contact_id: string | null; conversation_id: string | null }>(
      `select l.contact_id,
              (select c.id from conversations c
                where c.organization_id = l.organization_id and c.contact_id = l.contact_id
                order by c.last_message_at desc nulls last limit 1) as conversation_id
         from crm_leads l where l.organization_id = $1 and l.id = $2`,
      [org, leadId],
    );
    const l = rows[0];
    if (l === undefined || l.contact_id === null || l.conversation_id === null) return null;
    return {
      organizationId: org,
      conversationId: l.conversation_id,
      contactId: l.contact_id,
      actorType: doSupervisor ? 'ai_agent' : 'user',
      actorId: doSupervisor ? (str(row.metadata.actor_agent_id) ?? leadId) : userId!,
      eventId: row.id,
      origin: 'human_stage_changed',
      occurredAt: new Date(quando).toISOString(),
      traceId: `event_log:${row.id}`,
      originadoPorSupervisao: doSupervisor,
    };
  }
  return null;
}

export const supervisaoAcionamentoHumanoHandler: EventHandler = {
  key: SUPERVISAO_ACIONAMENTO_HUMANO_HANDLER_KEY,
  events: ['supervision.review_requested', 'lead.stage_changed'],
  async handle(row): Promise<HandlerResult> {
    try {
      const pool = getRequestPool();
      const fato = await fatoHumanoDoEvento(pool, row);
      if (fato === null) {
        return { consumer_key: SUPERVISAO_ACIONAMENTO_HUMANO_HANDLER_KEY, status: 'skipped', detail: 'nao_e_acao_humana' };
      }
      const resumo = await acionarSupervisao(pool, fato);
      return {
        consumer_key: SUPERVISAO_ACIONAMENTO_HUMANO_HANDLER_KEY,
        // `ok` descarta o detail no drain; o contador só sobrevive em `skipped`.
        status: resumo.enfileiradas > 0 ? 'ok' : 'skipped',
        detail:
          `vinculos=${resumo.vinculos} enfileiradas=${resumo.enfileiradas} duplicadas=${resumo.duplicadas} ` +
          `filtradas=${Object.entries(resumo.filtradas).map(([k, v]) => `${k}:${v}`).join(',') || '0'}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: SUPERVISAO_ACIONAMENTO_HUMANO_HANDLER_KEY, status: 'error', detail };
    }
  },
};
