/**
 * Supervisão de agente — o ACIONAMENTO: fato concluído → revisão durável → job.
 *
 * Duas portas, um caminho só:
 *
 *  1. EXECUÇÃO DA IA concluída. Chamado pelo RUNTIME no fim do turno do
 *     Conversador (`inbound-turn.ts`), depois de o checkpoint existir — o mesmo
 *     ponto e a mesma disciplina do `operator_turn`: quem dispara é o runtime,
 *     nunca o modelo, e a falha em acionar não derruba um turno que já respondeu.
 *  2. AÇÃO HUMANA concluída. Chamado pelo consumidor do `event_log`
 *     (`acionamento-humano.handler.ts`) para `message.sent` com autor pessoa e
 *     `lead.stage_changed` com autor pessoa — eventos emitidos DEPOIS do commit
 *     da ação, então os registros já estão persistidos quando a revisão lê.
 *
 * Nas duas, a mesma sequência: resolver vínculos → montar o evento do contrato
 * → filtrar (`decidirAcionamento`) → gravar a revisão pela chave de idempotência
 * → enfileirar `supervisor_review` com `source_event_id` derivado da MESMA chave.
 * Reentrega do fato encontra a revisão e o job existentes; nada duplica.
 *
 * Nenhuma revisão abre atendimento: o job não tem canal e a revisão não cria
 * conversa, mensagem nem caso.
 */
import type pg from 'pg';

import { enqueueJob } from '@/lib/agent-engine/queue/queue';

import {
  chaveDeIdempotencia,
  eventoDeRevisaoSchema,
  uuidDeterministico,
  type EventoDeRevisao,
  type OrigemDaRevisao,
  type TipoDeAtor,
} from './contrato';
import { decidirAcionamento, type VinculoDeSupervisao, type VinculoDoUsuario } from './politica';

type Log = {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
};

export interface FatoConcluido {
  organizationId: string;
  conversationId: string;
  contactId: string;
  actorType: TipoDeAtor;
  actorId: string;
  /** id estável do fato: job do Conversador, ou linha do `event_log`. */
  eventId: string;
  origin: OrigemDaRevisao;
  occurredAt: string;
  traceId: string;
  /** metadata do evento diz que a origem foi uma revisão de supervisão. */
  originadoPorSupervisao?: boolean;
}

export interface ResumoDoAcionamento {
  vinculos: number;
  enfileiradas: number;
  duplicadas: number;
  filtradas: Record<string, number>;
}

export async function acionarSupervisao(pool: pg.Pool, fato: FatoConcluido, log?: Log): Promise<ResumoDoAcionamento> {
  const resumo: ResumoDoAcionamento = { vinculos: 0, enfileiradas: 0, duplicadas: 0, filtradas: {} };
  const filtrar = (porque: string): void => {
    resumo.filtradas[porque] = (resumo.filtradas[porque] ?? 0) + 1;
  };

  // Quais vínculos PODEM se interessar pelo fato. Para IA, só os que supervisionam
  // aquele agente; para pessoa, todos os ligados da organização (o funil decide).
  const { rows: vinculos } = await pool.query<VinculoDeSupervisao & { allowed_stage_moves: unknown }>(
    `select id, organization_id, supervisor_agent_id, supervised_agent_id, pipeline_id, enabled,
            review_human_actions, mode, allowed_stage_moves, policy_version
       from ai_supervision_bindings
      where organization_id = $1 and enabled
        and ($2::text <> 'ai_agent' or supervised_agent_id = $3::uuid)`,
    [fato.organizationId, fato.actorType, fato.actorId],
  );
  if (vinculos.length === 0) return resumo;

  const { rows: sup } = await pool.query<{ supervisor_agent_id: string }>(
    `select distinct supervisor_agent_id from ai_supervision_bindings where organization_id = $1`,
    [fato.organizationId],
  );
  const supervisores = new Set(sup.map((r) => r.supervisor_agent_id));

  const { rows: conversa } = await pool.query<{ service_revision: string | null; contact_id: string }>(
    `select service_revision::text as service_revision, contact_id from conversations
      where organization_id = $1 and id = $2`,
    [fato.organizationId, fato.conversationId],
  );
  const conv = conversa[0];
  if (conv === undefined || conv.contact_id !== fato.contactId) {
    // Conversa de outra organização ou de outro contato: não é "sem vínculo", é
    // fato que não se sustenta. Nada é criado.
    log?.warn('supervisão: conversa do fato não pertence ao contato/organização', { event_id: fato.eventId });
    return resumo;
  }

  let vinculoDoUsuario: VinculoDoUsuario | null = null;
  if (fato.actorType === 'user') {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from user_organizations
        where organization_id = $1 and user_id = $2 and revoked_at is null and accepted_at is not null`,
      [fato.organizationId, fato.actorId],
    );
    const n = Number(rows[0]?.n ?? '0');
    vinculoDoUsuario = n === 1 ? 'valido' : n === 0 ? 'ausente' : 'ambiguo';
  }

  const { rows: leads } = await pool.query<{ id: string; pipeline_id: string; status: string }>(
    `select id, pipeline_id, status from crm_leads where organization_id = $1 and contact_id = $2`,
    [fato.organizationId, fato.contactId],
  );

  for (const bruto of vinculos) {
    resumo.vinculos += 1;
    const vinculo: VinculoDeSupervisao = { ...bruto, allowed_stage_moves: [] };

    // O funil do fato. Contato com negócio SÓ em outro funil: fato de outro
    // funil, filtro silencioso. Sem negócio nenhum: o fato é do funil do vínculo
    // e a revisão, se acontecer, é bloqueada com motivo — nunca inventada.
    const doFunil = leads.filter((l) => l.pipeline_id === vinculo.pipeline_id);
    if (leads.length > 0 && doFunil.length === 0) {
      filtrar('outro_funil');
      continue;
    }
    const abertos = doFunil.filter((l) => l.status === 'open');
    const leadId = abertos.length === 1 ? abertos[0]!.id : null;

    const evento: EventoDeRevisao = {
      event_id: fato.eventId,
      organization_id: fato.organizationId,
      conversation_id: fato.conversationId,
      contact_id: fato.contactId,
      lead_id: leadId,
      pipeline_id: vinculo.pipeline_id,
      actor_type: fato.actorType,
      actor_id: fato.actorId,
      occurred_at: fato.occurredAt,
      conversation_revision: conv.service_revision,
      origin: fato.origin,
      trace_id: fato.traceId.slice(0, 200),
    };
    const valido = eventoDeRevisaoSchema.safeParse(evento);
    if (!valido.success) {
      filtrar('evento_invalido');
      continue;
    }

    const decisao = decidirAcionamento(valido.data, vinculo, {
      supervisoresDaOrganizacao: supervisores,
      vinculoDoUsuario,
      originadoPorSupervisao: fato.originadoPorSupervisao === true,
    });
    if (!decisao.aciona) {
      filtrar(decisao.porque);
      continue;
    }

    const chave = chaveDeIdempotencia(valido.data, vinculo.supervisor_agent_id);
    const client = await pool.connect();
    try {
      // Revisão e job no MESMO commit: sem isso, uma falha entre os dois deixaria
      // revisão `pendente` sem ninguém para executá-la.
      await client.query('begin');
      const { rows: ins } = await client.query<{ id: string }>(
        `insert into ai_supervision_reviews
           (organization_id, binding_id, idempotency_key, event_id, conversation_id, contact_id, lead_id,
            pipeline_id, actor_type, actor_id, occurred_at, conversation_revision, origin, trace_id,
            supervisor_agent_id, policy_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::bigint,$13,$14,$15,$16)
         on conflict (organization_id, idempotency_key) do nothing
         returning id`,
        [
          evento.organization_id, vinculo.id, chave, evento.event_id, evento.conversation_id, evento.contact_id,
          evento.lead_id, evento.pipeline_id, evento.actor_type, evento.actor_id, evento.occurred_at,
          evento.conversation_revision, evento.origin, evento.trace_id, vinculo.supervisor_agent_id,
          vinculo.policy_version,
        ],
      );
      if (ins[0] === undefined) {
        await client.query('rollback');
        resumo.duplicadas += 1;
        continue;
      }
      const { job } = await enqueueJob(client, evento.organization_id, {
        kind: 'supervisor_review',
        leadId: evento.contact_id,
        sourceEventId: uuidDeterministico(chave),
        payload: { review_id: ins[0].id },
      });
      await client.query(
        `update ai_supervision_reviews set job_id = $3 where organization_id = $1 and id = $2`,
        [evento.organization_id, ins[0].id, job.id],
      );
      await client.query('commit');
      resumo.enfileiradas += 1;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return resumo;
}
