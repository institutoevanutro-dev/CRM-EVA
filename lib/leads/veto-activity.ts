import type pg from "pg";

import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

export interface VetoActivityInput {
  pool: pg.Pool;
  organizationId: string;
  /** No harness, "lead" é o CONTATO (inbound-turn: leadId = job.contact_id). */
  contactId: string;
  /** `before_send_traces.id` — o lastro desta decisão. */
  traceId: string;
  gate: string;
  code: string;
  agentId?: string | null;
}

/**
 * O agente decidiu NÃO falar — e isso vira linha na timeline.
 *
 * É o evento mais contra-intuitivo da entrega: o silêncio da IA com motivo é
 * informação (o humano vê que houve decisão e por quê); o silêncio sem registro
 * é abandono disfarçado de calmaria. Cenário 11 do §7.
 *
 * Roda no motor do agente, fora do request: escreve pelo `pg.Pool`, mas a linha
 * é montada pela MESMA regra da API (`buildLeadActivityRow`).
 *
 * Nunca lança: um veto registrado com sucesso não pode falhar por causa da
 * timeline dele.
 */
export async function emitVetoActivity(
  input: VetoActivityInput,
): Promise<{ routed: boolean; reason?: string }> {
  const r = await emitAgentActivityForContact({
    pool: input.pool,
    organizationId: input.organizationId,
    contactId: input.contactId,
    type: "send_vetoed",
    // Origem e prova coincidem aqui por natureza: a linha de auditoria do gate
    // é o que originou E o que sustenta. `source_id` fica com o ponteiro,
    // `evidence` com a referência — a fronteira DIRC continua valendo.
    sourceModule: "agent_guardrails",
    sourceId: input.traceId,
    evidence: { trace_ids: [input.traceId] },
    agentId: input.agentId ?? null,
    reason: vetoReason(input.gate, input.code),
    payload: { gate: input.gate, code: input.code },
  });
  return r.routed ? { routed: true } : { routed: false, reason: r.reason };
}

/**
 * O motivo legível de cada gate. O texto é GRAVADO em `crm_lead_activities.reason` e traduzido
 * na LEITURA (`t(item.reason)` na timeline e no painel do Inbox): cada valor precisa de uma
 * chave igual, byte a byte, em `lib/i18n/dicionario.ts` (bloco "Fase B").
 */
export const MOTIVO_DO_VETO_POR_GATE: Readonly<Record<string, string>> = {
  stop: "Não enviei: o contato pediu para parar de receber mensagens",
  window: "Não enviei: fora da janela de horário permitida",
  pacing: "Não enviei: limite de ritmo de envio atingido",
  budget: "Não enviei: orçamento de IA esgotado",
  warmup: "Não enviei: número ainda em aquecimento",
  promise: "Não enviei: a mensagem prometia algo que não posso garantir",
  unscheduled_followup:
    "Não enviei: a mensagem prometia uma nova tentativa ou resposta que não foi programada",
  internal_vocabulary:
    "Não enviei: a mensagem usava termos internos do sistema que o cliente não deve ler",
  horario_da_agenda:
    "Não enviei: a mensagem citava horário que a agenda não devolveu ou dizia que estava agendado sem ter marcado",
};

/** Motivo legível — o humano lê "não enviei porque", não um código de gate. */
export function vetoReason(gate: string, code: string): string {
  return MOTIVO_DO_VETO_POR_GATE[gate] ?? `Não enviei: bloqueado pela regra "${gate}" (${code})`;
}
