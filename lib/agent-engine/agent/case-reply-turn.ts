/**
 * Handler do job `case_reply_turn` (spec 15 §4.3) — o "loop de follow-up de
 * cabeça pra baixo": em vez do TEMPO reinjetar um turno (`followup_turn`), é a
 * RESPOSTA DO HUMANO a um caso aberto que reinjeta. Molde: `followup-turn.ts`.
 * A intenção aqui é DETERMINÍSTICA (veio do botão do humano na UI, Wave 5) —
 * o agente só redige/repassa, nunca reinterpreta a ação.
 *
 * Só as ações `resolved` e `need_lead_info` produzem re-entrada do agente.
 * `escalate` dispara `performHumanHandoff` direto na rota (Wave 5) e nunca
 * chega aqui. Reusa runAgentTurn por inteiro; a única diferença de
 * followup_turn é a abertura (bloco de re-entrada do caso, no sufixo) e a
 * resolução da conversa: pelo CASE (conversation_id), não pelo contato.
 *
 * Ids de envio (conversa + número) vêm da ROW real do caso/conversa (mesmo
 * banco), NUNCA do payload do modelo — o payload do humano só carrega
 * case_id/action/body, e o próprio case_id é validado contra organization_id
 * do job.
 */
import { z } from 'zod';
import type pg from 'pg';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import type { LeadContext } from '../edge/crm/get-lead-context';
import { ritualBlocks, runAgentTurn, type InboundTurnDeps, type LeadCheckpointRow } from './inbound-turn';
import type { LeadStateRow } from './lead-state';

/**
 * Payload enfileirado pela rota humana (Wave 5) ao agir sobre um caso.
 * `action` é `z.string()` (não enum) DE PROPÓSITO — uma action fora do escopo
 * de re-entrada (ex.: um valor inesperado por bug de outra camada) deve virar
 * no-op defensivo aqui, não um job morto por falha de parse. `.passthrough()`
 * tolerante, mesmo padrão de `followupTurnPayloadSchema`.
 */
export const caseReplyTurnPayloadSchema = z
  .object({
    case_id: z.string().uuid(),
    action: z.string(),
    body: z.string().optional(),
  })
  .passthrough();
export type CaseReplyTurnPayload = z.infer<typeof caseReplyTurnPayloadSchema>;

/** Ações que geram re-entrada do agente — `escalate` não passa por aqui (Wave 5). */
const REENTRY_ACTIONS = ['resolved', 'need_lead_info'] as const;
type ReentryAction = (typeof REENTRY_ACTIONS)[number];

function isReentryAction(action: string): action is ReentryAction {
  return (REENTRY_ACTIONS as readonly string[]).includes(action);
}

/**
 * Status ESPERADO do caso pra cada ação de re-entrada — a rota (Wave 5) faz a
 * transição + o enqueue no MESMO commit, então quando este job roda o caso JÁ
 * está no status pós-transição, não mais em `awaiting_human`. `resolved` é
 * status TERMINAL de propósito (o humano concluiu); checar contra
 * "ainda aberto" (como antes) descartava TODO envio de conclusão ao lead —
 * bug real da Wave 7, achado na prova E2E. Um status diferente do esperado
 * pra aquela action é sinal genuíno de corrida/anomalia → no-op defensivo.
 */
const EXPECTED_STATUS_FOR_ACTION: Record<ReentryAction, string> = {
  resolved: 'resolved',
  need_lead_info: 'awaiting_lead',
};

interface CaseConversationRow {
  conversationId: string;
  channelSessionId: string;
}

/**
 * Resolve a conversa DO CASO (não a mais recente do contato — o followup_turn
 * faz isso, mas um caso já sabe qual é a sua conversa). Retorna null quando o
 * caso não existe, está num status diferente do esperado pra esta `action`
 * (ver `EXPECTED_STATUS_FOR_ACTION`) ou a conversa não tem número associado —
 * todos os casos são NO-OP, nunca crash.
 */
async function resolveCaseConversation(
  pool: pg.Pool,
  tenantId: string,
  caseId: string,
  action: ReentryAction,
): Promise<CaseConversationRow | null> {
  const { rows } = await pool.query<{ status: string; conversation_id: string; channel_session_id: string | null }>(
    `select ac.status, ac.conversation_id, conv.channel_session_id
       from agent_cases ac
       join conversations conv
         on conv.id = ac.conversation_id and conv.organization_id = ac.organization_id
      where ac.organization_id = $1 and ac.id = $2`,
    [tenantId, caseId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (row.status !== EXPECTED_STATUS_FOR_ACTION[action] || row.channel_session_id === null) {
    return null;
  }
  return { conversationId: row.conversation_id, channelSessionId: row.channel_session_id };
}

/** Um caso cuja resposta do responsável este turno repassa ao lead. */
export interface CasoDoTurno {
  caseId: string;
  action: ReentryAction;
  body: string | undefined;
}

function instrucaoDoCaso({ caseId, action, body }: CasoDoTurno): string {
  const caseIdShort = caseId.slice(0, 8);
  const note = body?.trim() ?? '';
  return action === 'resolved'
    ? `O responsável concluiu o caso #${caseIdShort} com a nota: "${note}". Repasse essa conclusão ao lead de forma natural e encerre o assunto.`
    : `Para avançar no caso #${caseIdShort}, o responsável interno precisa que você obtenha do cliente: "${note}". ` +
        `Pergunte ao lead de forma natural. Assim que tiver a resposta, chame a tool provide_case_update com case_id "${caseId}".`;
}

/**
 * Abertura da re-entrada: instrução determinística do responsável (não
 * interpretação do modelo) no topo do sufixo + o ritual padrão. Com mais de
 * um caso (ver `casosIrmaosPendentes`), todos entram no MESMO turno e o
 * agente é instruído a responder numa mensagem só. Exportada PURA para teste
 * — igual a `buildFollowupOpeningMessage`.
 */
export function buildCaseReplyOpeningMessage(
  casos: readonly CasoDoTurno[],
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
  projeta = false,
): string {
  const varios = casos.length > 1;
  return [
    varios
      ? `Respostas do responsável interno sobre ${casos.length} casos que você abriu nesta conversa.`
      : 'Resposta do responsável interno sobre um caso que você abriu.',
    '',
    varios ? '## Instruções do responsável sobre os casos' : '## Instrução do responsável sobre o caso',
    ...casos.map(instrucaoDoCaso),
    ...(varios
      ? ['', 'Cubra TODOS os casos acima numa única resposta ao lead — nunca uma mensagem por caso.']
      : []),
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock, projeta),
    '',
    'Repasse ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
    'Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).',
    'Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).',
  ].join('\n');
}

/**
 * Os outros `case_reply_turn` PENDENTES da mesma conversa, para entrarem neste
 * turno. Medido em produção (16/10/2026): dois casos da mesma conversa
 * resolvidos com segundos de diferença viraram dois jobs na lane do contato,
 * e o paciente recebeu dois pares de mensagens quase iguais com 20s entre eles.
 *
 * A lane do contato garante que nenhum irmão está `running` enquanto este job
 * roda (uniq_job_queue_one_running_per_contact), então `pending` é o universo
 * inteiro. Cada irmão passa pela MESMA validação do job principal (ação de
 * re-entrada, status esperado do caso, conversa do caso) — irmão de outra
 * conversa fica para o seu próprio turno.
 */
async function casosIrmaosPendentes(
  pool: pg.Pool,
  job: JobRow,
  contactId: string,
  conversationId: string,
  jaIncluidos: ReadonlySet<string>,
): Promise<{ jobIds: string[]; casos: CasoDoTurno[] }> {
  const { rows } = await pool.query<{ id: string; payload: unknown }>(
    `select id, payload from job_queue
      where organization_id = $1 and contact_id = $2 and kind = 'case_reply_turn'
        and status = 'pending' and id <> $3
      order by created_at, id`,
    [job.organization_id, contactId, job.id],
  );
  const jobIds: string[] = [];
  const casos: CasoDoTurno[] = [];
  const vistos = new Set(jaIncluidos);
  for (const row of rows) {
    const parsed = caseReplyTurnPayloadSchema.safeParse(row.payload);
    if (!parsed.success || !isReentryAction(parsed.data.action)) continue;
    const action: ReentryAction = parsed.data.action;
    const conv = await resolveCaseConversation(pool, job.organization_id, parsed.data.case_id, action);
    if (conv === null || conv.conversationId !== conversationId) continue;
    jobIds.push(row.id);
    // O mesmo caso respondido duas vezes: o job é absorvido, a instrução não se repete.
    if (vistos.has(parsed.data.case_id)) continue;
    vistos.add(parsed.data.case_id);
    casos.push({ caseId: parsed.data.case_id, action, body: parsed.data.body });
  }
  return { jobIds, casos };
}

/**
 * Handler de `case_reply_turn` para o registry do daemon (main.ts). Resolve a
 * conversa pelo CASE (fonte confiável), no-opa em caso terminal/inexistente ou
 * action fora do escopo de re-entrada, e delega a runAgentTurn (mesmo núcleo
 * do inbound_turn/followup_turn).
 */
export function createCaseReplyTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('job case_reply_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = caseReplyTurnPayloadSchema.parse(job.payload);
    const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId, case_id: payload.case_id });

    if (!isReentryAction(payload.action)) {
      runLog.info('case_reply_turn no-op — action fora do escopo de re-entrada do agente', { action: payload.action });
      return;
    }
    const action: ReentryAction = payload.action;

    const caseConversation = await resolveCaseConversation(pool, tenantId, payload.case_id, action);
    if (caseConversation === null) {
      runLog.info('case_reply_turn no-op — caso inexistente, terminal ou sem número associado', {
        action: payload.action,
      });
      return;
    }

    const irmaos = await casosIrmaosPendentes(
      pool,
      job,
      leadId,
      caseConversation.conversationId,
      new Set([payload.case_id]),
    );
    const casos: CasoDoTurno[] = [{ caseId: payload.case_id, action, body: payload.body }, ...irmaos.casos];

    // Adiado pela janela ou falhou: lança daqui e os irmãos seguem `pending` —
    // quem rodar depois os absorve de novo. Nenhum caso se perde.
    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: caseConversation.channelSessionId,
      conversationId: caseConversation.conversationId,
      buildOpening: ({ previous, leadState, context, notesIndexBlock, projeta }) =>
        buildCaseReplyOpeningMessage(casos, previous, leadState, context, notesIndexBlock, projeta),
    });

    if (irmaos.jobIds.length > 0) {
      // ponytail: absorvidos fecham fora do commit do job principal; um crash
      // entre os dois deixa o irmão `pending` e ele repete a conclusão (o
      // comportamento de antes). Mover para o `inSameCommit` do completeJob se doer.
      const { rowCount } = await pool.query(
        `update job_queue set status = 'done', last_error = $3
          where organization_id = $1 and id = any($2::uuid[]) and status = 'pending'`,
        [tenantId, irmaos.jobIds, `absorvido pelo case_reply_turn ${job.id}`],
      );
      runLog.info('case_reply_turn absorveu os casos pendentes da mesma conversa', {
        absorvidos: rowCount ?? 0,
        casos: casos.length,
      });
    }
  };
}
