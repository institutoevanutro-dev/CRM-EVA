/**
 * Supervisão de agente — o CONTRATO do acionamento.
 *
 * Um agente (o supervisor) revisa, individualmente, o que outro agente (o
 * supervisionado) ou uma pessoa da equipe acabou de concluir numa conversa.
 * Revisar é administrativo: ler, classificar, atualizar o funil dentro do que a
 * configuração autoriza e registrar. NUNCA falar com o paciente — o handler não
 * tem canal, e isso é ausência de capacidade, não instrução de prompt.
 *
 * Este módulo é FOLHA (só zod e node:crypto): o evento é montado no worker
 * (fim do turno da IA) e no drain do event_log (ação humana), e os dois lados
 * precisam produzir exatamente a mesma chave para o mesmo fato.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

/** De onde veio o fato revisado. Vocabulário FECHADO — espelha o CHECK da 0265. */
export const ORIGENS_DE_REVISAO = [
  'ai_run_completed',
  'human_message_sent',
  'human_stage_changed',
] as const;
export type OrigemDaRevisao = (typeof ORIGENS_DE_REVISAO)[number];

export const TIPOS_DE_ATOR = ['ai_agent', 'user'] as const;
export type TipoDeAtor = (typeof TIPOS_DE_ATOR)[number];

/** Estados da revisão — espelham o CHECK de `ai_supervision_reviews.status`. */
export const STATUS_DE_REVISAO = [
  'pendente',
  'em_execucao',
  'concluida',
  'bloqueada',
  'falhou',
] as const;
export type StatusDaRevisao = (typeof STATUS_DE_REVISAO)[number];

/** Estados que encerram a revisão: reentrega devolve o resultado, não repete. */
export const STATUS_TERMINAIS: readonly StatusDaRevisao[] = ['concluida', 'bloqueada'];

/**
 * Os três códigos do registro.
 *
 * - `EXE`   ação administrativa autorizada E confirmada pela ferramenta.
 * - `RECOM` recomendação ainda não executada.
 * - `BLOQ`  ação impedida — por política, permissão, evidência, conflito ou falha.
 */
export const CODIGOS = ['EXE', 'RECOM', 'BLOQ'] as const;
export type CodigoDeResultado = (typeof CODIGOS)[number];

/**
 * O evento do acionamento — o contrato proposto na especificação.
 *
 * Todos os ids são uuid e vêm de FONTE CONFIÁVEL (row do job, linha do
 * event_log, linha do banco), nunca de texto do modelo. `lead_id` pode faltar:
 * a conversa pode não ter negócio no funil supervisionado — e aí a revisão é
 * bloqueada com motivo, não inventada.
 */
export const eventoDeRevisaoSchema = z
  .object({
    event_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    lead_id: z.string().uuid().nullable(),
    pipeline_id: z.string().uuid(),
    actor_type: z.enum(TIPOS_DE_ATOR),
    actor_id: z.string().uuid(),
    occurred_at: z.string().datetime({ offset: true }),
    conversation_revision: z.union([z.string().regex(/^\d+$/), z.null()]),
    origin: z.enum(ORIGENS_DE_REVISAO),
    trace_id: z.string().min(1).max(200),
  })
  .strict();
export type EventoDeRevisao = z.infer<typeof eventoDeRevisaoSchema>;

/** Payload do job `supervisor_review`: só o ponteiro da revisão durável. */
export const supervisorReviewPayloadSchema = z
  .object({
    review_id: z.string().uuid(),
  })
  .passthrough();

/**
 * A chave de idempotência da especificação:
 * `organization_id:conversation_id:event_id:supervisor_agent_id`.
 *
 * Reavaliar de propósito exige um NOVO evento — outro `event_id` —, e é por isso
 * que a chave não leva timestamp nem tentativa.
 */
export function chaveDeIdempotencia(
  evento: Pick<EventoDeRevisao, 'organization_id' | 'conversation_id' | 'event_id'>,
  supervisorAgentId: string,
): string {
  return [
    evento.organization_id,
    evento.conversation_id,
    evento.event_id,
    supervisorAgentId,
  ].join(':');
}

/**
 * Chave de cada ação. Determinística: a mesma revisão pretendendo a mesma
 * mudança produz a mesma chave, e o `unique (organization_id, action_key)` do
 * banco impede o segundo registro numa retentativa.
 */
export function chaveDaAcao(
  reviewId: string,
  kind: 'mover_etapa' | 'registrar_pendencia',
  alvo: string,
): string {
  return `${reviewId}:${kind}:${alvo}`;
}

/**
 * UUID determinístico a partir de um texto (formato v5, hash sha256 truncado).
 *
 * Serve de `job_queue.source_event_id`: o índice único
 * `(organization_id, source_event_id)` passa a deduplicar o JOB pela mesma chave
 * que deduplica a revisão. Não dá para usar o `event_id` cru: ele é o id do job
 * do Conversador, que já é `source_event_id` do `operator_turn` do mesmo turno.
 */
export function uuidDeterministico(texto: string): string {
  const h = createHash('sha256').update(`deskcomm:supervisao:${texto}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // versão 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Versão do texto fixo que enquadra o supervisor. Muda quando `SYSTEM_DO_SUPERVISOR` muda. */
export const VERSAO_DO_ENQUADRAMENTO = 'supervisao-v1';
