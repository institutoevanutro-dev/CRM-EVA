import { z } from "zod";

/** Espelho do CHECK de `mensagens_agendadas.status` (migration 0416). */
export const SITUACOES_DO_AGENDAMENTO = ["agendada", "encaminhada", "falhou", "cancelada"] as const;
/** Espelho do CHECK de `mensagens_agendadas.se_desconectado` (migration 0416). */
export const SE_DESCONECTADO = ["esperar", "cancelar"] as const;

/**
 * Edição de uma mensagem de texto agendada: o texto, o horário e o que fazer se
 * o número estiver fora do ar. Contato e número NÃO vêm do corpo: saem da
 * conversa, lida pela sessão (primeira parte da #3118 — envio único).
 */
export const editarAgendamentoSchema = z
  .object({
    title: z.string().trim().max(120).optional().nullable(),
    body: z.string().trim().min(1, "mensagem_vazia").max(4096),
    scheduled_at: z.iso.datetime(),
    se_desconectado: z.enum(SE_DESCONECTADO).default("esperar"),
  })
  .strict();

/** Criação: a edição mais a conversa onde o atendente agendou. */
export const criarAgendamentoSchema = editarAgendamentoSchema.extend({ conversation_id: z.uuid() }).strict();

/** O horário precisa estar no futuro: agendar para o passado seria enviar agora sem ninguém pedir. */
export function horarioNoFuturo(scheduledAt: string, agora: Date = new Date()): boolean {
  return new Date(scheduledAt).getTime() > agora.getTime();
}
