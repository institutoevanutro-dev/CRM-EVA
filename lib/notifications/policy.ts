import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";

export function shouldNotifyInbound(input: {
  direction?: string | null;
  conversationId?: string | null;
  openConversationId?: string | null;
  tabFocused: boolean;
  tipo?: unknown;
}): boolean {
  if (input.tipo === "reassinado") return false;
  if (input.direction !== "inbound") return false;
  if (!input.conversationId) return false;
  if (input.tabFocused && input.openConversationId === input.conversationId) return false;
  return true;
}

/** O que a rota `GET /api/v1/conversations/[id]` devolve e a regra lê. */
export interface ConversaDoAviso {
  status?: string | null;
  assigned_to_user_id?: string | null;
  bot_silenced_until?: string | null;
  contacts?: { force_human?: boolean | null; is_blocked?: boolean | null } | null;
}

/**
 * A conversa está com o automático? Então a mensagem nova não avisa ninguém:
 * quem responde é ele. Mesma regra do selo do Inbox (`comandoDaConversa`).
 *
 * Só cala com CERTEZA: conversa ou "a org tem automático?" desconhecidos
 * (leitura falhou, sem permissão) avisam — numa instalação sem agente, toda
 * conversa sem dono pareceria "do automático" e nada mais tocaria.
 */
export function conversaNoAutomatico(conversa: ConversaDoAviso | null, automaticoDaOrg: boolean | undefined): boolean {
  if (!conversa || automaticoDaOrg !== true || typeof conversa.status !== "string") return false;
  return (
    comandoDaConversa({
      status: conversa.status,
      assigned_to_user_id: conversa.assigned_to_user_id ?? null,
      bot_silenced_until: conversa.bot_silenced_until ?? null,
      force_human: conversa.contacts?.force_human ?? null,
      is_blocked: conversa.contacts?.is_blocked ?? null,
      automaticoDaOrg,
    }).comando.quem === "automatico"
  );
}
