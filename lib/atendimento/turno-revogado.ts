import type { Pool } from "pg";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { avisarRespostaDeCasoObsoleto } from "./aviso-caso-obsoleto";
import { StaleServiceBoundaryError } from "./fronteira";

/**
 * O FIM DE UM TURNO QUE UMA PESSOA INTERROMPEU AO ASSUMIR A CONVERSA.
 *
 * "Assumir"/"Transferir" revoga o turno no banco (migration 0361): o
 * `inbound_turn`/`case_reply_turn` já sai de lá `failed`, e o `followup_turn` em
 * execução ganha só o fato `conversation.autonomous_turn_revoked`, porque a
 * sessão de quem clicou não pode escrever em job de follow-up. Quando o turno
 * tropeça nisso (a escrita seguinte recusada, ou o `completeJob` sem lease), o
 * catch do worker chama esta função ANTES do caminho comum: não é incidente,
 * não vai ao Sentry e não vira `failJob` (que o devolveria à fila).
 *
 * O follow-up: encerra o turno sob o lease original e deixa `turn_discarded` na
 * inscrição viva no mesmo nó, para o motor enfileirar um turno novo quando a
 * política do fluxo deixar (`turnoDaAcaoDescartado`). Sem esse rastro o
 * dead-man leria "turno em voo que nunca terminou" e mataria a inscrição. A
 * chave termina em `:descartado`, como em `followup-turn.ts`. Lease já trocado
 * (reaper, outro worker): nada é escrito no ciclo novo.
 *
 * Devolve `true` quando era um turno revogado (e já foi encerrado).
 * Porte de melgarafael/DeskcommCRM #2541 (@ozzure), na forma do fork.
 */
export async function encerrarTurnoRevogado(
  pool: Pool,
  job: JobRow,
  workerId: string,
  erro: unknown,
  log: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<boolean> {
  if (!["inbound_turn", "followup_turn", "case_reply_turn"].includes(job.kind)) return false;
  const { rows } = await pool.query<{ revogado: boolean }>(
    "select public.fn_autonomous_turn_revoked($1,$2) as revogado",
    [job.organization_id, job.id],
  );
  if (rows[0]?.revogado !== true) return false;

  if (
    erro instanceof StaleServiceBoundaryError &&
    job.kind === "case_reply_turn" &&
    typeof job.payload.case_id === "string"
  ) {
    await avisarRespostaDeCasoObsoleto(pool, job.organization_id, job.payload.case_id);
  }
  const claim = claimOfJob(job);
  if (job.kind === "followup_turn" && claim) {
    const tx = await pool.connect();
    let erroNaTransacao: Error | undefined;
    try {
      await tx.query("begin");
      const { rows: meu } = await tx.query(
        `select id from job_queue where organization_id=$1 and id=$2 and kind='followup_turn'
           and status='running' and locked_by=$3 and locked_at=$4::timestamptz for update`,
        [job.organization_id, job.id, claim.worker_id, claim.acquired_at],
      );
      if (meu.length) {
        await tx.query(
          `insert into followup_enrollment_events
             (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           select $1, e.id, e.current_node_id, 'turn_discarded',
                  jsonb_build_object('job_id', $2::text, 'motivo', 'conversation_command_taken'),
                  coalesce(nullif($3::text, ''), $2::text) || ':descartado'
             from followup_enrollments e
            where e.organization_id = $1 and e.id::text = $4 and e.current_node_id = $5
              and e.status in ('active', 'waiting_reply', 'paused_handoff', 'paused_manual')
              and $6::text = 'send_message'
           on conflict (enrollment_id, idempotency_key) where idempotency_key is not null do nothing`,
          [
            job.organization_id,
            job.id,
            job.payload.source_step_key ?? null,
            job.payload.followup_enrollment_id ?? null,
            job.payload.node_id ?? null,
            job.payload.purpose ?? null,
          ],
        );
        await cancelJob(tx, job.id, workerId, "conversation_command_taken", claim.acquired_at);
      }
      await tx.query("commit");
    } catch (falha) {
      erroNaTransacao = falha instanceof Error ? falha : new Error(String(falha));
      await tx.query("rollback").catch(() => undefined);
      throw falha;
    } finally {
      tx.release(erroNaTransacao);
    }
  }
  log.warn("turno da IA interrompido: uma pessoa assumiu a conversa", {
    job_id: job.id,
    organization_id: job.organization_id,
    kind: job.kind,
  });
  return true;
}
