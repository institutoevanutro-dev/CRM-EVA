/**
 * Handler do job `supervisor_review` — a revisão de supervisão (migration 0263).
 *
 * É a fiação fina entre a fila e `lib/supervisao/executor.ts`. O que ele dá ao
 * executor é deliberadamente POUCO:
 *
 * - um banco estreito (`createPgSupervisaoDb`), sem função de envio;
 * - UMA chamada de modelo, sem ferramentas (`tools` ausente), que devolve texto;
 * - o supervisor PUBLICADO, lido a cada job.
 *
 * Não recebe `ChannelAdapter`, não monta MCP, não chama `runBeforeSend`. "Nenhum
 * envio por WhatsApp" é ausência de capacidade, não instrução de prompt — mesma
 * doutrina do `operator_turn` (spec 16), um passo mais estrita: o Operador ainda
 * tem ferramentas de escrita; o supervisor não tem nenhuma.
 *
 * Org e contato vêm da ROW do job (regra dura nº 1). O payload só aponta a
 * revisão, e o executor confere que ela é da mesma organização.
 */
import type pg from 'pg';

import { renderAgora } from '@/lib/tempo/agora';
import { supervisorReviewPayloadSchema } from '@/lib/supervisao/contrato';
import { createPgSupervisaoDb } from '@/lib/supervisao/db-pg';
import { executarRevisao, type SupervisaoDeps, type SupervisorPublicado } from '@/lib/supervisao/executor';
import { SYSTEM_DO_SUPERVISOR, montarBriefingDoSupervisor } from '@/lib/supervisao/proposta';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import { runModelCall } from '../edge/llm/run-model-call';
import { loadPublishedAgentConfigById } from './agent-config';
import { fusoDaOrganizacao } from './fuso-da-org';
import type { InboundTurnDeps } from './inbound-turn';

export function createSupervisorReviewHandler(deps: InboundTurnDeps) {
  return async function handleSupervisorReview(
    job: JobRow,
    pool: pg.Pool,
    ctx: { workerId: string },
  ): Promise<void> {
    const tenantId = job.organization_id;
    if (job.contact_id === null) {
      throw new Error('supervisor_review sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = supervisorReviewPayloadSchema.parse(job.payload);
    const log = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, review_id: payload.review_id });

    const supervisaoDeps: SupervisaoDeps = {
      db: createPgSupervisaoDb(pool),
      log,
      async carregarSupervisor(orgId, agentId): Promise<SupervisorPublicado | null> {
        const cfg = await loadPublishedAgentConfigById(pool, orgId, agentId);
        // Pausado conta como indisponível: pausar um agente é dizer "não trabalhe".
        if (cfg === null || cfg.pausedAt) return null;
        return { agentId: cfg.agentId, versionId: cfg.versionId, politicas: cfg.systemPrompt };
      },
      async proporRevisao({ revisao, vinculo, estado, supervisor }) {
        const cfg = await loadPublishedAgentConfigById(pool, tenantId, supervisor.agentId);
        if (cfg === null) throw new Error('supervisor deixou de estar publicado durante a revisão');
        const saida = await runModelCall(
          pool,
          deps.llmCfg,
          {
            tenantId,
            leadId: job.contact_id,
            jobId: job.id,
            agentId: supervisor.agentId,
            // Custo próprio: "quanto custa a supervisão?" precisa de resposta.
            purpose: 'supervisor_review',
            system: SYSTEM_DO_SUPERVISOR,
            messages: [
              {
                role: 'user',
                content: montarBriefingDoSupervisor({
                  politicasPublicadas: supervisor.politicas,
                  evento: revisao,
                  estado,
                  vinculo,
                  agoraBlock: renderAgora(deps.clock?.() ?? new Date(), await fusoDaOrganizacao(pool, tenantId, log)),
                }),
              },
            ],
            // SEM `tools`. É isto que faz o supervisor não ter mão.
            maxSteps: 1,
            model: cfg.model,
            llmOverride: { provider: cfg.provider, credentialId: cfg.credentialId },
          },
          { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log },
        );
        return saida.result.text;
      },
    };

    const desfecho = await executarRevisao(supervisaoDeps, tenantId, payload.review_id);
    log.info('supervisão — desfecho', {
      tipo: desfecho.tipo,
      status: 'status' in desfecho ? desfecho.status : null,
      codigo: 'codigo' in desfecho ? desfecho.codigo : null,
      acoes: 'acoes' in desfecho ? desfecho.acoes : [],
    });

    // Registro append no event_log, `done` (não é item de trabalho): torna
    // contável quantas revisões rodaram e com que desfecho.
    try {
      await pool.query(
        `insert into event_log (organization_id, event_type, entity_kind, entity_id, status, payload)
         values ($1, 'agent.supervisor_review', 'contact', $2, 'done', $3::jsonb)`,
        [
          tenantId,
          job.contact_id,
          JSON.stringify({
            review_id: payload.review_id,
            tipo: desfecho.tipo,
            status: 'status' in desfecho ? desfecho.status : null,
            codigo: 'codigo' in desfecho ? desfecho.codigo : null,
          }),
        ],
      );
    } catch (err) {
      log.warn('desfecho da supervisão não foi registrado no event_log', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
    void ctx;
  };
}
