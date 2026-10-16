/**
 * Labels pt-br congelados da aba Automações (UI-T3). Fonte única — a timeline
 * de atividade (UI-T4) importa os mesmos mapas, nunca redeclara os textos.
 */
import type { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];
export type ActionType =
  | "create_or_move_lead"
  | "send_whatsapp_message"
  | "send_ai_message"
  | "add_tag"
  | "assign_owner"
  | "call_webhook"
  | "start_message_flow";

export const TRIGGER_LABELS: Record<TriggerEvent, string> = {
  "lead.created": "Quando entrar um contato novo (webhook)",
  "lead.stage_changed": "Quando um lead mudar de etapa",
  "message.received": "Quando chegar mensagem no WhatsApp",
  "lead.tag_added": "Quando um lead ganhar uma tag",
  // Pensado para o pós-venda: com "Criar/mover lead" apontando para OUTRO funil,
  // nasce um card novo lá e a venda fica ganha onde está
  // (lib/automation/actions/create-or-move-lead.ts).
  "lead.won": "Quando um negócio for ganho",
  "contact.tag_added": "Quando um contato ganhar uma tag",
  // A frase evita "agendamento criado", que não diz ao operador o que ele vê na
  // agenda: um horário marcado pode nascer pendente (o tipo pede confirmação) ou
  // já confirmado, e os dois caem aqui.
  "appointment.created": "Quando um horário for marcado",
  "appointment.confirmed": "Quando um horário pendente for confirmado",
  "appointment.rescheduled": "Quando um horário for remarcado",
  "appointment.cancelled": "Quando um horário for cancelado",
  "contact.birthday": "No aniversário de um contato",
  "contact.phone_added": "Quando um contato ganhar um telefone",
};

export const ACTION_LABELS: Record<ActionType, string> = {
  create_or_move_lead: "Criar/mover lead no funil",
  send_whatsapp_message: "Enviar mensagem no WhatsApp",
  send_ai_message: "Mensagem escrita pela IA",
  add_tag: "Adicionar tag",
  assign_owner: "Atribuir a um atendente",
  call_webhook: "Avisar outro sistema (webhook)",
  start_message_flow: "Iniciar fluxo de mensagem",
};
