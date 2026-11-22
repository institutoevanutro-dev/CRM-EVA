/**
 * O AGENTE QUE VAI RESPONDER JÁ FALOU NESTE ATENDIMENTO? A âncora do "já
 * engajado" do filtro de palavra-chave (porte de melgarafael/DeskcommCRM
 * #3240, issue #3142 de lá).
 *
 * O filtro decide a ENTRADA do agente na conversa, não cada mensagem. Com ele
 * julgando cada mensagem, o agente perguntava "qual procedimento?" e a resposta
 * do paciente, sem a palavra do filtro, deixava a IA calada no meio.
 *
 * A testemunha é a linha que o envio grava: outbound, `sent_via = 'ai'`,
 * `metadata->>'ai_actor_id'` = este agente, não falhada, dentro do atendimento
 * corrente (`sent_at >= service_started_at`, a mesma fronteira do histórico em
 * `get-lead-context.ts`; nulo conta como dentro). O sticky do roteador não
 * serve: sem roteador nunca é gravado, e com roteador é gravado antes do
 * portão. Fala de outro agente não engaja este.
 *
 * Erro de leitura sobe (a fila tenta de novo): `false` ali calaria quem já
 * conversa com o agente.
 */
import type pg from 'pg';

export async function agenteJaRespondeuNoAtendimento(
  db: Pick<pg.Pool, 'query'>,
  alvo: { organizationId: string; conversationId: string; agentId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ respondeu: boolean }>(
    `select exists (
       select 1
         from messages m
         join conversations c
           on c.organization_id = m.organization_id and c.id = m.conversation_id
        where m.organization_id = $1
          and m.conversation_id = $2
          and m.direction = 'outbound'
          and m.sent_via = 'ai'
          and m.metadata->>'ai_actor_id' = $3
          and m.status <> 'failed'
          and (c.service_started_at is null or m.sent_at >= c.service_started_at)
     ) as respondeu`,
    [alvo.organizationId, alvo.conversationId, alvo.agentId],
  );
  return rows[0]?.respondeu === true;
}
