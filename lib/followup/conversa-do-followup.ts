import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Um contato pode ter conversas em mais de um canal (WhatsApp e Instagram).
 * Follow-up sempre prefere o WhatsApp quando ele existe; Instagram só entra
 * quando não há nenhuma conversa 1:1 de WhatsApp.
 */
export interface ConversaCandidata {
  channel: string;
  channel_session_id: string | null;
  is_group: boolean;
  last_message_at: string | null;
  created_at: string;
}

function maisRecentePrimeiro(a: ConversaCandidata, b: ConversaCandidata): number {
  const chave = (c: ConversaCandidata) => Date.parse(c.last_message_at ?? c.created_at);
  return chave(b) - chave(a);
}

/** WhatsApp 1:1 mais recente; senão Instagram 1:1 mais recente; senão undefined. Puro. */
export function sessaoPreferidaParaFollowup(conversas: ConversaCandidata[]): string | undefined {
  const elegiveis = conversas
    .filter((c) => !c.is_group && c.channel_session_id)
    .sort(maisRecentePrimeiro);
  const whatsapp = elegiveis.find((c) => c.channel === "whatsapp");
  if (whatsapp) return whatsapp.channel_session_id!;
  const instagram = elegiveis.find((c) => c.channel === "instagram");
  return instagram?.channel_session_id ?? undefined;
}

/** Lê as conversas 1:1 do contato (org-filtrado) e aplica a regra. */
export async function sessaoDoFollowup(
  admin: SupabaseClient,
  org: string,
  contactId: string,
): Promise<string | undefined> {
  const { data, error } = await admin
    .from("conversations")
    .select("channel, channel_session_id, is_group, last_message_at, created_at")
    .eq("organization_id", org)
    .eq("contact_id", contactId)
    .eq("is_group", false);
  if (error) {
    logger.warn("sessao_do_followup_query_failed", { org, contactId, error: error.message });
    return undefined;
  }
  return sessaoPreferidaParaFollowup((data ?? []) as ConversaCandidata[]);
}
