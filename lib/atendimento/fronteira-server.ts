import { assertAgentOperationPg, type AgentOperationContext } from "@/lib/ai/agents/operation";
import { assertApprovedReplyPg } from "@/lib/ai/replies/delivery";
import { assertMeetingDeliveryPg } from "@/lib/agenda/meet-delivery";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { withAgendaEffect, guardAgendaEffect } from "@/lib/agenda/efeito";
import { pessoaNoComandoDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";
import { logger } from "@/lib/logger";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable, JobRow } from "@/lib/agent-engine/queue/queue";
import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  assertCurrentServiceBoundary,
  parseServiceBoundary,
  type CurrentServiceBoundary,
  type ServiceBoundary,
} from "./fronteira";

const execution = new AsyncLocalStorage<{
  db: Queryable;
  boundary: ServiceBoundary | null;
  job?: JobRow;
  agentOperation?: AgentOperationContext;
  /** Ver `guardServiceTools`: a própria IA passou a vez neste turno. */
  iaPassouAVez?: boolean;
  /** Ferramentas de escrita deste turno ainda rodando (o modelo pede várias no mesmo passo). */
  escritasEmCurso?: number;
}>();
export const SERVICE_BOUNDARY_SQL = `select c.organization_id, c.contact_id, c.id as conversation_id,
 c.service_revision::float8 as service_revision, c.current_demanda_id as demanda_id,
 d.revision::float8 as demanda_revision, c.status, d.fechada_em::text as demanda_fechada_em
 from conversations c left join demandas d on d.id=c.current_demanda_id and d.organization_id=c.organization_id and d.contact_id=c.contact_id
 where c.organization_id=$1 and c.id=$2`;
export async function readCurrentServiceBoundary(
  db: Queryable,
  org: string,
  conversation: string,
): Promise<CurrentServiceBoundary | null> {
  const { rows } = await db.query<CurrentServiceBoundary>(SERVICE_BOUNDARY_SQL, [
    org,
    conversation,
  ]);
  return rows[0] ?? null;
}
export async function requireCurrentServiceBoundary(
  db: Queryable,
  boundary: ServiceBoundary | null,
): Promise<void> {
  assertCurrentServiceBoundary(
    boundary,
    boundary
      ? await readCurrentServiceBoundary(db, boundary.organization_id, boundary.conversation_id)
      : null,
  );
}
export function currentExecutionBoundary(): ServiceBoundary | null {
  return execution.getStore()?.boundary ?? null;
}
export function currentExecutionJob(): JobRow | null {
  return execution.getStore()?.job ?? null;
}
export function setExecutionAgentOperation(context: AgentOperationContext): void {
  const scope = execution.getStore();
  if (scope) scope.agentOperation = context;
}
export async function guardServiceEffect(): Promise<void> {
  const scope = execution.getStore();
  if (scope?.agentOperation) await assertAgentOperationPg(scope.db, scope.agentOperation);
  if (scope) await requireCurrentServiceBoundary(scope.db, scope.boundary);
  if (scope?.job?.kind === "transactional_delivery") {
    const claim = claimOfJob(scope.job);
    if (!claim) assertCurrentServiceBoundary(null, null);
    await assertMeetingDeliveryPg(scope.db, {
      organizationId: scope.job.organization_id,
      jobId: scope.job.id,
      jobClaim: claim!,
    });
  }
  if (scope?.job?.kind === "approved_reply") {
    const claim = claimOfJob(scope.job);
    if (!claim) assertCurrentServiceBoundary(null, null);
    await assertApprovedReplyPg(scope.db, {
      organizationId: scope.job.organization_id,
      jobId: scope.job.id,
      jobClaim: claim!,
    });
  }
  await guardAgendaEffect();
}
/** Continuação sem job (ex.: decisão humana sobre um caso já existente). */
export async function withServiceBoundary<T>(
  db: Queryable,
  boundary: ServiceBoundary | null,
  action: () => Promise<T>,
): Promise<T> {
  await requireCurrentServiceBoundary(db, boundary);
  return execution.run({ db, boundary }, action);
}
/** Trabalho legado é stale. Flywheel/watchdog sem contato não são atendimento. */
export async function withServiceJob<T>(
  db: Queryable,
  job: JobRow,
  action: () => Promise<T>,
): Promise<T> {
  if (
    ![
      "inbound_turn",
      "followup_turn",
      "case_reply_turn",
      "operator_turn",
      "transactional_delivery",
      "approved_reply",
    ].includes(job.kind)
  )
    return action();
  const boundary = parseServiceBoundary(job.payload.service_boundary);
  if (
    boundary &&
    (boundary.organization_id !== job.organization_id || boundary.contact_id !== job.contact_id)
  ) {
    assertCurrentServiceBoundary(null, null);
  }
  await requireCurrentServiceBoundary(db, boundary);
  return execution.run({ db, boundary, job }, () =>
    job.kind === "followup_turn" && job.contact_id
      ? withAgendaEffect(
          db,
          {
            organizationId: job.organization_id,
            contactId: job.contact_id,
            jobId: job.id,
            jobClaim: claimOfJob(job),
            enrollmentId:
              typeof job.payload.followup_enrollment_id === "string"
                ? job.payload.followup_enrollment_id
                : undefined,
            nodeId: typeof job.payload.node_id === "string" ? job.payload.node_id : undefined,
          },
          action,
        )
      : action(),
  );
}
/** Turnos em que a IA age sozinha. Operador, resposta aprovada e entrega do link são ordem de pessoa. */
const TURNOS_AUTONOMOS = new Set(["inbound_turn", "followup_turn", "case_reply_turn"]);
/** A conferência destas é por BOLHA, em `sendTurnMessage`, com o recado próprio ao modelo. */
const ENVIOS = new Set(["send_message", "send_media", "send_template"]);
const RECUSA_POR_PESSOA_NO_COMANDO = {
  ok: false as const,
  error: {
    code: "pessoa_no_comando",
    message:
      "Uma pessoa da equipe assumiu esta conversa enquanto você trabalhava; esta ação NÃO foi executada e nada foi " +
      "alterado. NÃO tente de novo nem chame outra ferramenta de escrita neste turno: encerre agora. A pessoa segue o atendimento.",
  },
};

/**
 * Guarda no execute real. Tools desconhecidas são mutáveis por default.
 *
 * UMA PESSOA ASSUMIU NO MEIO DO TURNO: A IA TAMBÉM PARA DE ESCREVER NO CRM.
 * O envio já confere isso a cada bolha (`pessoaAssumiuAConversa`, PR #212 do
 * fork). Faltava o resto do turno: a recepção respondia pelo celular, a
 * mensagem da IA era descartada e a ferramenta seguinte ainda marcava o
 * horário ou movia o negócio, sem ninguém avisar o paciente. É a parte do
 * upstream #2541 que o #212 não cobria, com a régua do #212 e sem migration:
 * antes de cada ferramenta de escrita de um turno autônomo, a mesma leitura por
 * chave primária. Recusa de ENSINO (o turno fecha e o job termina `done`), no
 * mesmo formato da bolha descartada.
 *
 * A exceção é a IA que passou a vez ELA MESMA (`request_human_handoff` grava
 * `force_human`): o que ela ainda grava depois, no mesmo turno, continua
 * valendo. Por isso a conferência se repete DEPOIS de cada escrita: se a
 * conversa mudou de mãos durante uma ferramenta deste turno, foi o turno.
 *
 * ponytail: uma pessoa que assuma exatamente enquanto uma ferramenta deste
 * turno roda (qualquer uma fora das leituras nativas) é contada como "foi o
 * turno" e as escritas seguintes passam; a mensagem continua barrada pelo
 * envio. Separar os dois casos pede marcar no banco quem silenciou. A janela
 * cai do turno inteiro (10 a 40 s de modelo) para a duração das ferramentas.
 */
export function guardServiceTools(tools: ToolSet | undefined): ToolSet | undefined {
  if (!tools || !execution.getStore()) return tools;
  const reads = new Set([
    "get_lead_context",
    "get_lead_note",
    "search_knowledge",
    "read_skill_reference",
  ]);
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      if (reads.has(name) || !definition.execute) return [name, definition];
      const execute = definition.execute;
      return [
        name,
        {
          ...definition,
          execute: async (...args: Parameters<typeof execute>) => {
            const scope = execution.getStore();
            const conversa = scope?.boundary;
            const kind = scope?.job?.kind;
            if (!scope || !conversa || !kind || !TURNOS_AUTONOMOS.has(kind) || ENVIOS.has(name)) {
              await guardServiceEffect();
              return execute(...args);
            }
            const pessoaNoComando = () =>
              pessoaNoComandoDaConversa(
                scope.db,
                { organizationId: conversa.organization_id, conversationId: conversa.conversation_id },
                kind,
              );
            const motivo = scope.iaPassouAVez || scope.escritasEmCurso ? null : await pessoaNoComando();
            if (motivo !== null) {
              logger.info("ferramenta recusada: uma pessoa assumiu a conversa durante o turno", {
                job_id: scope.job?.id,
                organization_id: conversa.organization_id,
                conversation_id: conversa.conversation_id,
                ferramenta: name,
                motivo,
              });
              return RECUSA_POR_PESSOA_NO_COMANDO as never;
            }
            await guardServiceEffect();
            scope.escritasEmCurso = (scope.escritasEmCurso ?? 0) + 1;
            try {
              return await execute(...args);
            } finally {
              if (!scope.iaPassouAVez && (await pessoaNoComando().catch(() => null)) !== null) {
                scope.iaPassouAVez = true;
              }
              scope.escritasEmCurso -= 1;
            }
          },
        },
      ];
    }),
  ) as ToolSet;
}
