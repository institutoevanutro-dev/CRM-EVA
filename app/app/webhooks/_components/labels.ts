/**
 * Labels pt-br congelados da aba Automações (UI-T3). Fonte única — a timeline
 * de atividade (UI-T4) importa os mesmos mapas, nunca redeclara os textos.
 */
import type { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];
export type ActionType =
  | "create_or_move_lead"
  | "send_whatsapp_message"
  | "send_email"
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
  send_email: "Enviar e-mail",
  send_ai_message: "Mensagem escrita pela IA",
  add_tag: "Adicionar tag",
  assign_owner: "Atribuir a um atendente",
  call_webhook: "Avisar outro sistema (webhook)",
  start_message_flow: "Iniciar fluxo de mensagem",
};

/**
 * O que falta, em português, a partir do primeiro erro do Zod.
 *
 * A mensagem crua do Zod é técnica e em inglês ("Too small: expected string to
 * have >=1 characters", "Invalid UUID") e não diz o campo. Aqui o campo vem do
 * `path` do erro. Erro `custom` já nasce em português no schema
 * (`lib/schemas/webhooks.ts`) e passa como está. Toda frase devolvida é chave
 * do dicionário: quem chama passa por `t()`.
 */
const MENSAGEM_POR_CAMPO: Record<string, string> = {
  name: "Dê um nome à automação.",
  trigger_event: "Escolha quando a automação roda.",
  conditions: "Revise as condições: escolha o campo e preencha o valor.",
  pipeline_id: "Escolha o funil na ação.",
  stage_id: "Escolha a etapa na ação.",
  channel_session_id: "Escolha o número de WhatsApp na ação.",
  template: "Escreva a mensagem da ação.",
  agent_id: "Escolha o agente na ação.",
  instruction: "Escreva a instrução para a IA.",
  user_id: "Escolha o atendente na ação.",
  url: "Preencha o endereço (https://…) do outro sistema.",
  flow_pointer_id: "Escolha o fluxo de mensagem na ação.",
  assunto: "Escreva o assunto do e-mail.",
  corpo: "Escreva o texto do e-mail.",
  email_fixo: "Confira o e-mail que recebe os envios.",
};

export function mensagemDoErroDaAutomacao(
  issue: { code: string; path: PropertyKey[]; message: string } | undefined,
): string {
  if (!issue) return "Revise os campos da automação.";
  if (issue.code === "custom") return issue.message;
  const [raiz] = issue.path;
  if (raiz === "actions" && issue.path.length === 1) {
    return issue.code === "too_big" ? "Use no máximo 10 ações." : "Adicione pelo menos uma ação.";
  }
  if (issue.code === "too_big") return "Um dos campos passou do tamanho máximo.";
  if (raiz === "conditions") return MENSAGEM_POR_CAMPO.conditions!;
  const campo = [...issue.path].reverse().find((p): p is string => typeof p === "string");
  return (campo && MENSAGEM_POR_CAMPO[campo]) || "Revise os campos da automação.";
}
