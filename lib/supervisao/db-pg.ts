/**
 * Adaptador pg de `SupervisaoDb` — o único arquivo da supervisão que conhece SQL.
 *
 * Roda no agent-worker (pg puro, service role, SEM RLS). Por isso TODA consulta
 * filtra `organization_id` explicitamente, com o id vindo da linha do job — a
 * regra dura nº 1 do repositório (anti-pattern nº 10 do CLAUDE.md).
 *
 * Não existe aqui função de envio de mensagem, de agenda ou de pagamento. A
 * ausência é a garantia: o executor não tem como pedir o que o adaptador não
 * oferece.
 */
import type pg from 'pg';

import { buildLeadActivityRow } from '@/lib/leads/activity-emitter';

import type { AcaoRow, ResultadoDaMovimentacao, RevisaoRow, SupervisaoDb } from './executor';
import type { EstadoLido, TransicaoAutorizada, VinculoDeSupervisao, VinculoDoUsuario } from './politica';

/** Janela de mensagens que o supervisor enxerga. Knob de código, não de env. */
export const MENSAGENS_NO_RETRATO = 40;

const COLUNAS_DA_REVISAO = `id, organization_id, binding_id, idempotency_key, event_id, conversation_id,
  contact_id, lead_id, pipeline_id, actor_type, actor_id,
  to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
  conversation_revision::text as conversation_revision, origin, trace_id, supervisor_agent_id,
  status, outcome_code, policy_version, proposal, exit_reason, attempts`;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function lerTransicoes(bruto: unknown): TransicaoAutorizada[] {
  if (!Array.isArray(bruto)) return [];
  const uuid = /^[0-9a-f-]{36}$/i;
  return bruto.flatMap((t: unknown) => {
    if (typeof t !== 'object' || t === null) return [];
    const to = (t as { to_stage_id?: unknown }).to_stage_id;
    const from = (t as { from_stage_ids?: unknown }).from_stage_ids;
    if (typeof to !== 'string' || !uuid.test(to)) return [];
    const fromIds = Array.isArray(from) ? from.filter((f): f is string => typeof f === 'string' && uuid.test(f)) : [];
    return [{ to_stage_id: to, from_stage_ids: fromIds }];
  });
}

export function createPgSupervisaoDb(pool: pg.Pool): SupervisaoDb {
  return {
    async carregarRevisao(orgId, reviewId) {
      const { rows } = await pool.query<RevisaoRow>(
        `select ${COLUNAS_DA_REVISAO} from ai_supervision_reviews where organization_id = $1 and id = $2`,
        [orgId, reviewId],
      );
      return rows[0] ?? null;
    },

    async iniciarRevisao(orgId, reviewId) {
      const { rows } = await pool.query<RevisaoRow>(
        `update ai_supervision_reviews
            set status = 'em_execucao', attempts = attempts + 1, started_at = coalesce(started_at, now())
          where organization_id = $1 and id = $2 and status in ('pendente', 'em_execucao', 'falhou')
          returning ${COLUNAS_DA_REVISAO}`,
        [orgId, reviewId],
      );
      return rows[0] ?? null;
    },

    async carregarVinculo(orgId, bindingId) {
      const { rows } = await pool.query<Omit<VinculoDeSupervisao, 'allowed_stage_moves'> & { allowed_stage_moves: unknown }>(
        `select id, organization_id, supervisor_agent_id, supervised_agent_id, pipeline_id, enabled,
                review_human_actions, mode, allowed_stage_moves, policy_version
           from ai_supervision_bindings where organization_id = $1 and id = $2`,
        [orgId, bindingId],
      );
      const r = rows[0];
      return r === undefined ? null : { ...r, allowed_stage_moves: lerTransicoes(r.allowed_stage_moves) };
    },

    async supervisoresDaOrganizacao(orgId) {
      const { rows } = await pool.query<{ supervisor_agent_id: string }>(
        `select distinct supervisor_agent_id from ai_supervision_bindings where organization_id = $1`,
        [orgId],
      );
      return new Set(rows.map((r) => r.supervisor_agent_id));
    },

    async vinculoDoUsuario(orgId, userId): Promise<VinculoDoUsuario> {
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from user_organizations
          where organization_id = $1 and user_id = $2 and revoked_at is null and accepted_at is not null`,
        [orgId, userId],
      );
      const n = Number(rows[0]?.n ?? '0');
      return n === 1 ? 'valido' : n === 0 ? 'ausente' : 'ambiguo';
    },

    async lerEstado(revisao): Promise<EstadoLido> {
      const org = revisao.organization_id;
      const [lead, contato, conversa, etapas, mensagens, humanasEtapa, humanasMsg, agendamentos, followups, agora] =
        await Promise.all([
          pool.query<{
            id: string; pipeline_id: string; stage_id: string; status: string;
            stage_changed_at: Date | null; owner_kind: string | null; owner_user_id: string | null;
          }>(
            // O negócio DO FUNIL SUPERVISIONADO. Com mais de um aberto, nenhum é
            // escolhido: adivinhar moveria o card errado.
            `select id, pipeline_id, stage_id, status, stage_changed_at, owner_kind, owner_user_id
               from crm_leads
              where organization_id = $1 and contact_id = $2 and pipeline_id = $3
                and ($4::uuid is null or id = $4::uuid)
              order by (status = 'open') desc, created_at desc
              limit 2`,
            [org, revisao.contact_id, revisao.pipeline_id, revisao.lead_id],
          ),
          pool.query<{ is_blocked: boolean; force_human: boolean; is_anonymized: boolean }>(
            `select is_blocked, force_human, is_anonymized from contacts where organization_id = $1 and id = $2`,
            [org, revisao.contact_id],
          ),
          pool.query<{ id: string; service_revision: string | null; assigned_to_user_id: string | null; humano: boolean }>(
            `select id, service_revision::text as service_revision, assigned_to_user_id,
                    -- Mesma definição de handoff de \`isLeadInHandoff\`: conversa só
                    -- ATRIBUÍDA não é atendimento humano em curso (o roteamento
                    -- atribui responsável a toda conversa).
                    (bot_silenced_until is not null and bot_silenced_until > now()) as humano
               from conversations where organization_id = $1 and id = $2`,
            [org, revisao.conversation_id],
          ),
          pool.query<EstadoLido['etapas'][number]>(
            `select id, name, is_won, is_lost, is_archived, requires_human, blocks_followups
               from crm_stages where organization_id = $1 and pipeline_id = $2 order by position`,
            [org, revisao.pipeline_id],
          ),
          pool.query<{
            id: string; direction: 'inbound' | 'outbound'; sent_via: string; sent_by_user_id: string | null;
            type: string; created_at: Date; body: string | null;
          }>(
            `select * from (
               select id, direction, sent_via, sent_by_user_id, type, created_at, body
                 from messages where organization_id = $1 and conversation_id = $2
                order by created_at desc limit $3
             ) m order by created_at asc`,
            [org, revisao.conversation_id, MENSAGENS_NO_RETRATO],
          ),
          pool.query<{ id: string; performed_at: Date }>(
            `select a.id, a.performed_at from crm_lead_activities a
               join crm_leads l on l.id = a.lead_id and l.organization_id = a.organization_id
              where a.organization_id = $1 and l.contact_id = $2 and l.pipeline_id = $3
                and a.type = 'stage_changed' and a.actor_kind = 'user' and a.performed_at > $4::timestamptz
                -- A própria ação humana revisada não é "mudança depois do fato".
                and not ($5::text = 'human_stage_changed' and a.performed_by_user_id = $6::uuid
                         and a.performed_at <= $4::timestamptz + interval '5 seconds')`,
            [org, revisao.contact_id, revisao.pipeline_id, revisao.occurred_at, revisao.origin, revisao.actor_id],
          ),
          pool.query<{ id: string }>(
            `select id from messages
              where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
                and sent_by_user_id is not null and created_at > $3::timestamptz`,
            [org, revisao.conversation_id, revisao.occurred_at],
          ),
          pool.query<{ id: string; status: string; starts_at: Date }>(
            `select id, status, starts_at from calendar_appointments
              where organization_id = $1 and contact_id = $2 and starts_at > now() and status <> 'cancelled'
              order by starts_at limit 5`,
            [org, revisao.contact_id],
          ),
          pool.query<{ id: string; status: string; pointer_id: string }>(
            `select id, status, pointer_id from followup_enrollments
              where organization_id = $1 and contact_id = $2 and status in ('active', 'waiting_reply', 'paused_handoff')`,
            [org, revisao.contact_id],
          ),
          pool.query<{ agora: Date }>('select now() as agora'),
        ]);

      const abertos = lead.rows.filter((l) => l.status === 'open');
      const l = revisao.lead_id !== null ? lead.rows[0] : abertos.length === 1 ? abertos[0] : undefined;
      const c = contato.rows[0];
      const v = conversa.rows[0];
      if (c === undefined || v === undefined) {
        throw new Error('supervisão: contato ou conversa da revisão não encontrados na organização');
      }
      return {
        lida_em: iso(agora.rows[0]?.agora) ?? new Date().toISOString(),
        lead: l === undefined
          ? null
          : {
              id: l.id,
              pipeline_id: l.pipeline_id,
              stage_id: l.stage_id,
              status: l.status,
              stage_changed_at: iso(l.stage_changed_at),
              owner_kind: l.owner_kind,
              owner_user_id: l.owner_user_id,
            },
        contato: c,
        conversa: {
          id: v.id,
          service_revision: v.service_revision,
          assigned_to_user_id: v.assigned_to_user_id,
          em_atendimento_humano: v.humano,
        },
        etapas: etapas.rows,
        mensagens: mensagens.rows.map((m) => ({ ...m, created_at: iso(m.created_at)! })),
        mudancas_humanas_de_etapa_apos_evento: humanasEtapa.rows.map((r) => ({
          activity_id: r.id,
          performed_at: iso(r.performed_at)!,
        })),
        mensagens_humanas_apos_evento: humanasMsg.rows.map((r) => r.id),
        agendamentos_futuros: agendamentos.rows.map((a) => ({ id: a.id, status: a.status, starts_at: iso(a.starts_at)! })),
        followups_vivos: followups.rows,
      };
    },

    async gravarProposta(orgId, reviewId, proposta, promptVersion) {
      await pool.query(
        `update ai_supervision_reviews set proposal = $3::jsonb, prompt_version = $4
          where organization_id = $1 and id = $2 and proposal is null`,
        [orgId, reviewId, JSON.stringify(proposta), promptVersion],
      );
    },

    async carregarAcao(orgId, actionKey) {
      const { rows } = await pool.query<AcaoRow>(
        `select id, action_key, kind, expected_stage_id, status, code, tool_result_ref
           from ai_supervision_actions where organization_id = $1 and action_key = $2`,
        [orgId, actionKey],
      );
      return rows[0] ?? null;
    },

    async registrarAcao(input) {
      const { rows } = await pool.query<AcaoRow>(
        `with ins as (
           insert into ai_supervision_actions
             (organization_id, review_id, action_key, kind, expected_stage_id, target_stage_id, evidence_ids, reason, next_owner)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           on conflict (organization_id, action_key) do nothing
           returning id, action_key, kind, expected_stage_id, status, code, tool_result_ref
         )
         select * from ins
         union all
         select id, action_key, kind, expected_stage_id, status, code, tool_result_ref from ai_supervision_actions
          where organization_id = $1 and action_key = $3 and not exists (select 1 from ins)`,
        [
          input.organization_id, input.review_id, input.action_key, input.kind, input.expected_stage_id,
          input.target_stage_id, JSON.stringify(input.evidence_ids), input.reason.slice(0, 1000), input.next_owner,
        ],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('supervisão: ação não registrada');
      return r;
    },

    async finalizarAcao(orgId, actionId, patch) {
      await pool.query(
        `update ai_supervision_actions
            set status = $3, code = $4, tool_result_ref = $5, reason = coalesce($6, reason)
          where organization_id = $1 and id = $2 and status in ('pendente', 'falhou')`,
        [orgId, actionId, patch.status, patch.code, patch.tool_result_ref, patch.reason?.slice(0, 1000) ?? null],
      );
    },

    async moverEtapaComTrava(input): Promise<ResultadoDaMovimentacao> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Idempotência pela chave da ação: a transação de uma tentativa anterior
        // pode ter commitado e o registro do desfecho, não.
        const ja = await client.query<{ id: string }>(
          `select id from crm_lead_activities
            where organization_id = $1 and lead_id = $2 and type = 'stage_changed'
              and source_module = 'supervisao' and payload->>'action_key' = $3
            limit 1`,
          [input.organization_id, input.lead_id, input.action_key],
        );
        if (ja.rows[0] !== undefined) {
          await client.query('commit');
          return { ok: true, ref: ja.rows[0].id };
        }

        // A TRAVA: etapa esperada, carimbo da última mudança e revisão da
        // conversa, lidos antes. `for update` na conversa serializa contra o
        // atendimento humano que esteja gravando nela agora.
        const conv = await client.query<{ service_revision: string | null }>(
          `select service_revision::text as service_revision from conversations
            where organization_id = $1 and id = $2 for update`,
          [input.organization_id, input.conversation_id],
        );
        if ((conv.rows[0]?.service_revision ?? null) !== input.service_revision_esperada) {
          await client.query('rollback');
          return { ok: false, porque: 'conflito' };
        }
        const upd = await client.query<{ id: string; pipeline_id: string }>(
          `update crm_leads set stage_id = $3
            where organization_id = $1 and id = $2 and status = 'open'
              and stage_id = $4
              and stage_changed_at is not distinct from $5::timestamptz
              and exists (select 1 from crm_stages s where s.organization_id = $1 and s.id = $3
                           and s.pipeline_id = crm_leads.pipeline_id and not s.is_archived
                           and not s.is_won and not s.is_lost)
            returning id, pipeline_id`,
          [input.organization_id, input.lead_id, input.para_etapa_id, input.de_etapa_id, input.stage_changed_at_esperado],
        );
        const movido = upd.rows[0];
        if (movido === undefined) {
          await client.query('rollback');
          return { ok: false, porque: 'conflito' };
        }

        const row = buildLeadActivityRow({
          organizationId: input.organization_id,
          leadId: input.lead_id,
          contactId: input.contact_id,
          type: 'stage_changed',
          sourceModule: 'supervisao',
          sourceId: input.review_id,
          actor: { type: 'ai_agent', id: input.supervisor_agent_id, agent_id: input.supervisor_agent_id, role: 'agent' },
          reason: input.motivo.slice(0, 400),
          evidence: { trace_ids: [input.trace_id] },
          payload: { action_key: input.action_key, de: input.de_etapa_id, para: input.para_etapa_id, review_id: input.review_id },
        });
        const act = await client.query<{ id: string }>(
          `insert into crm_lead_activities
             (organization_id, lead_id, contact_id, type, source_module, source_id,
              actor_kind, actor_agent_id, performed_by_user_id, reason, evidence, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           returning id`,
          [
            row.organization_id, row.lead_id, row.contact_id, row.type, row.source_module, row.source_id,
            row.actor_kind, row.actor_agent_id, row.performed_by_user_id, row.reason,
            row.evidence ? JSON.stringify(row.evidence) : null, JSON.stringify(row.payload),
          ],
        );
        // O mesmo evento que toda mão que move emite — follow-ups e automações
        // reagem igual. `actor_kind: 'supervisor'` é o que corta o ciclo.
        await client.query(
          `select public.emit_event('lead.stage_changed', 'crm_lead', $2::uuid, $3::jsonb, $4::jsonb, $1::uuid)`,
          [
            input.organization_id,
            input.lead_id,
            JSON.stringify({
              pipeline_id: movido.pipeline_id,
              from_stage_id: input.de_etapa_id,
              to_stage_id: input.para_etapa_id,
              status: 'open',
            }),
            JSON.stringify({
              actor_kind: 'supervisor',
              actor_agent_id: input.supervisor_agent_id,
              source: 'supervisao',
              review_id: input.review_id,
            }),
          ],
        );
        await client.query('commit');
        return { ok: true, ref: act.rows[0]!.id };
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async abrirPendencia(input) {
      // Dedupe pela chave da ação dentro do corpo seria frágil; o título mais a
      // conversa (kind_e_ref) já impede dois avisos abertos iguais, e a chave da
      // ação vai no fim do corpo para correlação.
      const { rows } = await pool.query<{ id: string }>(
        `with existente as (
           select id from agent_inbox_items
            where organization_id = $1 and kind = 'supervision_review' and ref_kind = 'conversation'
              and ref_id = $2 and body like '%' || $5
            limit 1
         ), ins as (
           insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
           select $1, 'supervision_review', 'warn', $3, $4 || E'\\n\\nref: ' || $5, 'conversation', $2
            where not exists (select 1 from existente)
           returning id
         )
         select id from ins union all select id from existente`,
        [input.organization_id, input.conversation_id, input.titulo, input.corpo.slice(0, 1500), input.action_key],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('supervisão: pendência não registrada');
      return { ref: `agent_inbox_items:${r.id}` };
    },

    async concluirRevisao(orgId, reviewId, patch) {
      await pool.query(
        `update ai_supervision_reviews
            set status = $3, outcome_code = $4, state_read = coalesce($5::jsonb, state_read),
                stage_before_id = $6, stage_recommended_id = $7, exit_reason = $8,
                human_validator_user_id = $9, finished_at = now()
          where organization_id = $1 and id = $2`,
        [
          orgId, reviewId, patch.status, patch.outcome_code,
          patch.state_read === null ? null : JSON.stringify(patch.state_read),
          patch.stage_before_id, patch.stage_recommended_id, patch.exit_reason?.slice(0, 300) ?? null,
          patch.human_validator_user_id ?? null,
        ],
      );
    },

    async registrarAtividade(input) {
      const row = buildLeadActivityRow({
        organizationId: input.organization_id,
        leadId: input.lead_id,
        contactId: input.contact_id,
        type: 'supervision_review',
        sourceModule: 'supervisao',
        sourceId: input.review_id,
        actor: { type: 'ai_agent', id: input.supervisor_agent_id, agent_id: input.supervisor_agent_id, role: 'agent' },
        reason:
          `Supervisão: ${input.contagem.EXE} executada(s), ${input.contagem.RECOM} recomendada(s), ` +
          `${input.contagem.BLOQ} bloqueada(s).`,
        evidence: { trace_ids: [input.trace_id] },
        payload: { review_id: input.review_id, codigo: input.codigo, contagem: input.contagem },
      });
      await pool.query(
        `insert into crm_lead_activities
           (organization_id, lead_id, contact_id, type, source_module, source_id,
            actor_kind, actor_agent_id, performed_by_user_id, reason, evidence, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row.organization_id, row.lead_id, row.contact_id, row.type, row.source_module, row.source_id,
          row.actor_kind, row.actor_agent_id, row.performed_by_user_id, row.reason,
          row.evidence ? JSON.stringify(row.evidence) : null, JSON.stringify(row.payload),
        ],
      );
    },
  };
}
