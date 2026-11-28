/**
 * O PACIENTE CONFIRMA A PRESENÇA RESPONDENDO AO LEMBRETE — o leitor.
 *
 * Pedido do dono em 27/11/2026: o lembrete pede "responda SIM" e o CRM só LÊ a
 * resposta. Não responde nada ao paciente: quem conversa é o agente (ou a
 * equipe), como antes. Design em
 * docs/superpowers/specs/2026-11-28-paciente-confirma-pelo-lembrete-design.md.
 *
 * O erro caro é o falso positivo: um "sim" que respondia a OUTRA pergunta marca
 * "Presença confirmada", a recepção não liga na véspera e o horário fica vazio.
 * Por isso duas réguas, as duas conservadoras:
 *
 *   1. a mensagem INTEIRA tem de ser a confirmação ("sim, mas…" não é);
 *   2. a última mensagem da clínica antes do "sim" tem de ser o lembrete
 *      carimbado, e ter saído. Se a IA ou a recepção mandou outra coisa depois
 *      dele, o "sim" responde àquilo, e nada é lido.
 *
 * E só lê no tipo de compromisso com a chave "Pedir confirmação no lembrete"
 * ligada (`reminder_asks_confirmation`, desligada por padrão: nada muda em
 * clínica nenhuma até alguém ligar). A checagem mora AQUI e não no RPC porque o
 * botão da equipe confirma com a chave desligada.
 *
 * Quem decide se o compromisso ainda aceita a confirmação (status, horário
 * futuro, revisão, já confirmado) é o banco, em `fn_appointment_patient_confirm`
 * (migration 0441), não este arquivo.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type { Actor } from "@/lib/api/handlers/types";
import { normalizarTexto } from "@/lib/opt-out/deteccao";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

import { leadAtivoDoContato } from "./lead-ativo-do-contato";
import type { AtividadeDaAgenda, OrigemDaConfirmacaoDoPaciente } from "./tipos";

/**
 * Acrescentada pelo sistema ao lembrete do tipo com a chave ligada, para nunca
 * faltar a palavra que este leitor sabe ler. Definida no módulo puro do texto
 * (a prévia da tela a usa, e este arquivo puxa servidor) e reexportada aqui.
 */
export { FRASE_PEDIDO_DE_CONFIRMACAO } from "./texto-do-lembrete";

/** A linha "Paciente confirmou presença" na timeline do negócio. */
export const ATIVIDADE_DA_PRESENCA_CONFIRMADA = "appointment_patient_confirmed" satisfies AtividadeDaAgenda;

/**
 * As respostas lidas como confirmação, já normalizadas (minúsculas, sem acento,
 * pontuação de borda e vírgula viram espaço). Decisão 4 da spec.
 */
const CONFIRMACOES: ReadonlySet<string> = new Set([
  "sim",
  "1",
  "confirmo",
  "confirmado",
  "confirmada",
  "sim confirmo",
  "vou sim",
  "estarei ai",
  "👍",
  "✅",
]);

/**
 * A mensagem inteira é uma confirmação de presença?
 *
 * Pergunta nunca confirma: "?" não sai com a pontuação de borda, então "sim?"
 * não casa. Tom de pele e seletor de variação do emoji saem antes da
 * comparação ("👍🏽" vale "👍").
 */
export function ehConfirmacaoDePresenca(texto: string): boolean {
  const limpo = normalizarTexto(texto)
    .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, "")
    .replace(/[\s.,;:!¡]+/gu, " ")
    .trim();
  return CONFIRMACOES.has(limpo);
}

/** Onde o lembrete carimba o compromisso na própria mensagem: `messages.metadata.agenda_lembrete`. */
export const CHAVE_DO_CARIMBO_DO_LEMBRETE = "agenda_lembrete";

const carimboSchema = z.object({ appointment_id: z.uuid(), revision: z.number().int() });

/** O que o lembrete grava em `metadata[CHAVE_DO_CARIMBO_DO_LEMBRETE]`. */
export type CarimboDoLembrete = z.infer<typeof carimboSchema>;

/** O carimbo do lembrete, ou `null` quando a mensagem não é um lembrete (ou o carimbo está torto). */
export function lerCarimboDoLembrete(metadata: unknown): { appointmentId: string; revision: number } | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const lido = carimboSchema.safeParse((metadata as Record<string, unknown>)[CHAVE_DO_CARIMBO_DO_LEMBRETE]);
  return lido.success ? { appointmentId: lido.data.appointment_id, revision: lido.data.revision } : null;
}

const ORIGEM: OrigemDaConfirmacaoDoPaciente = "mensagem";

/** A mensagem chegou pelo canal e o produto agiu: o mesmo ator do opt-out em `pos-entrada.ts`. */
const ATOR = { type: "webhook_source", id: "canal-inbound" } as const;

/** O lembrete carimbado que ainda não saiu (ou não saiu nunca): o paciente não o viu. */
const LEMBRETE_NAO_ENTREGUE: ReadonlySet<string> = new Set(["queued", "failed"]);

export type ResultadoDaLeitura =
  | "nao_e_confirmacao"
  | "sem_lembrete"
  | "chave_desligada"
  | "confirmado"
  | "ja_confirmado"
  | "nao_se_aplica";

/**
 * Lê a resposta do paciente e, se ela confirma o último lembrete, grava a
 * presença confirmada.
 *
 * Erro de banco SOBE: quem chama (`pos-entrada.ts`) roda isto fora do caminho
 * do despacho e registra a falha no log. A timeline e a auditoria, depois de
 * gravada a confirmação, falham para dentro.
 */
export async function lerConfirmacaoDoLembrete(e: {
  admin: ReturnType<typeof createAdminClient>;
  organizationId: string;
  conversationId: string;
  contactId: string;
  /** A mensagem do paciente: é a prova que o RPC confere. */
  messageId: string;
  body: string;
  requestId?: string;
}): Promise<ResultadoDaLeitura> {
  if (!ehConfirmacaoDePresenca(e.body)) return "nao_e_confirmacao";
  const { admin } = e;

  const { data: resposta, error: erroDaResposta } = await admin
    .from("messages")
    .select("created_at")
    .eq("organization_id", e.organizationId)
    .eq("conversation_id", e.conversationId)
    .eq("id", e.messageId)
    .maybeSingle();
  if (erroDaResposta) throw new Error(`resposta_nao_lida: ${erroDaResposta.message}`);
  if (!resposta) return "sem_lembrete";

  // A última da clínica antes do "sim", seja de quem for (IA, equipe, automação).
  // Um relógio só, o nosso: `created_at` é quando cada mensagem chegou a NÓS. O
  // `sent_at` do inbound é o relógio do aparelho (ver o porquê em
  // `lib/agent-engine/edge/crm/drain.ts`, na espera pela mídia).
  const { data: ultima, error: erroDaUltima } = await admin
    .from("messages")
    .select("metadata, status")
    .eq("organization_id", e.organizationId)
    .eq("conversation_id", e.conversationId)
    .eq("direction", "outbound")
    .lt("created_at", resposta.created_at)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroDaUltima) throw new Error(`ultima_da_clinica_nao_lida: ${erroDaUltima.message}`);
  const carimbo = lerCarimboDoLembrete(ultima?.metadata);
  if (!carimbo || LEMBRETE_NAO_ENTREGUE.has(ultima?.status ?? "")) return "sem_lembrete";

  // A chave do tipo. O tipo é embutido pela única FK que leva a ele, com a
  // organização filtrada nos dois lados: tipo de outra organização vale "desligada".
  const { data: compromisso, error: erroDoTipo } = await admin
    .from("calendar_appointments")
    .select("tipo:calendar_event_types!calendar_appointments_event_type_id_fkey(reminder_asks_confirmation)")
    .eq("organization_id", e.organizationId)
    .eq("id", carimbo.appointmentId)
    .eq("tipo.organization_id", e.organizationId)
    .maybeSingle();
  if (erroDoTipo) throw new Error(`tipo_do_compromisso_nao_lido: ${erroDoTipo.message}`);
  const tipo = (compromisso as { tipo: { reminder_asks_confirmation: boolean } | null } | null)?.tipo;
  if (tipo?.reminder_asks_confirmation !== true) return "chave_desligada";

  const { data, error } = await admin.rpc("fn_appointment_patient_confirm", {
    p_appointment_id: carimbo.appointmentId,
    p_expected_revision: carimbo.revision,
    p_source: ORIGEM,
    p_message_id: e.messageId,
    p_user_id: null,
  });
  if (error) throw new Error(`confirmacao_nao_gravada: ${error.message}`);
  const resultado = data as "confirmado" | "ja_confirmado" | "nao_se_aplica";
  if (resultado !== "confirmado") return resultado;

  await registrarPresencaConfirmada(admin, {
    organizationId: e.organizationId,
    appointmentId: carimbo.appointmentId,
    contactId: e.contactId,
    source: ORIGEM,
    actor: ATOR,
    messageId: e.messageId,
    requestId: e.requestId,
  });
  return "confirmado";
}

/**
 * Os efeitos da presença já gravada, pelos dois caminhos (a resposta ao lembrete
 * e o botão "Paciente confirmou" da equipe): a auditoria `agenda.paciente_confirmou`
 * e a linha na timeline do negócio ativo do contato, pela mesma régua das outras
 * atividades da agenda (`leadAtivoDoContato`). Sem negócio, ou com a escrita
 * falhando, o rastro vira `event_log` por `registraFalhaDeAtividade`, com o id
 * do negócio quando há um e o do contato quando não há.
 * Nunca lança: a confirmação já está gravada.
 */
export async function registrarPresencaConfirmada(
  db: SupabaseClient,
  e: {
    organizationId: string;
    appointmentId: string;
    contactId: string;
    source: OrigemDaConfirmacaoDoPaciente;
    actor: Actor;
    /** A resposta do paciente, quando a origem é a mensagem. */
    messageId?: string;
    requestId?: string;
  },
): Promise<void> {
  // A auditoria antes da timeline: ela não lança, e a linha dela não pode depender da outra.
  void audit({
    action: "agenda.paciente_confirmou",
    actorUserId: e.actor.type === "user" ? e.actor.id : null,
    organizationId: e.organizationId,
    resourceType: "calendar_appointment",
    resourceId: e.appointmentId,
    requestId: e.requestId,
    metadata: { appointment_id: e.appointmentId, source: e.source },
  });

  const falha = (ancora: string, erro: string | undefined, origem = "agenda (confirmação do paciente)") =>
    registraFalhaDeAtividade(db, {
      organizationId: e.organizationId,
      leadId: ancora,
      tipo: ATIVIDADE_DA_PRESENCA_CONFIRMADA,
      origem,
      erro,
      requestId: e.requestId,
    });
  let leadId: string | null = null;
  try {
    leadId = await leadAtivoDoContato(db, e.organizationId, e.contactId);
    if (!leadId) return await falha(e.contactId, undefined, "agenda (sem negócio aberto para ancorar)");

    const { ok, error } = await emitLeadActivity(db, {
      organizationId: e.organizationId,
      leadId,
      contactId: e.contactId,
      type: ATIVIDADE_DA_PRESENCA_CONFIRMADA,
      sourceModule: "agenda",
      sourceId: e.appointmentId,
      actor: e.actor,
      reason:
        e.source === "mensagem"
          ? "O paciente confirmou a presença respondendo ao lembrete"
          : "A equipe registrou que o paciente confirmou a presença",
      payload: e.messageId ? { source: e.source, message_id: e.messageId } : { source: e.source },
    });
    if (!ok) await falha(leadId, error);
  } catch (err) {
    await falha(leadId ?? e.contactId, err instanceof Error ? err.message.slice(0, 160) : "desconhecido");
  }
}
