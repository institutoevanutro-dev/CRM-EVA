/**
 * Contatos da agenda do celular (`smb_app_state_sync`) → `contacts`.
 *
 * A regra "preenche o nome só quando vazio, nunca sobrescreve o editado no CRM"
 * é da RPC (`display_name = coalesce(display_name, nullif(p_notify,''))`), não
 * daqui — o teste de contrato do baseline a sustenta. Sem lead, conversa nem IA:
 * só o cadastro do contato, sempre dentro da `organizationId` da sessão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { canonicalPhoneBR } from "../phone-variants";

export async function upsertContatosDoCelular(
  admin: SupabaseClient,
  organizationId: string,
  contatos: Array<{ waId: string; nome: string | null }>,
): Promise<{ processados: number }> {
  let processados = 0;
  for (const c of contatos) {
    const { error } = await admin.rpc(
      "fn_upsert_wa_contact" as never,
      { p_org: organizationId, p_kind: "phone", p_phone: canonicalPhoneBR(`+${c.waId}`), p_lid: null, p_chat_id: c.waId, p_notify: c.nome } as never,
    );
    if (error) {
      logger.error("[meta.contatos] contato do celular não gravado", { detail: error.message });
      continue;
    }
    processados++;
  }
  return { processados };
}
