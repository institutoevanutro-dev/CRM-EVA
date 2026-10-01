/**
 * Contatos da agenda do celular (`smb_app_state_sync`) → nome de contato que JÁ existe.
 *
 * SÓ ATUALIZA: preenche `display_name` vazio de contato da organização achado
 * pelo telefone (as duas grafias do nono dígito). Nunca cria contato (importaria
 * a agenda inteira do celular), nunca sobrescreve nome, não toca em
 * `source_metadata` nem `phone_number`. Sem lead, conversa nem IA.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { phoneLookupVariants } from "../phone-variants";

// ponytail: um UPDATE por contato, 25 em paralelo (nomes diferem, não cabe um
// só statement sem RPC). Se agendas de dezenas de milhares pesarem, vira RPC
// com unnest().
const PARALELO = 25;

export async function upsertContatosDoCelular(
  admin: SupabaseClient,
  organizationId: string,
  contatos: Array<{ waId: string; nome: string | null }>,
): Promise<{ processados: number }> {
  const comNome = contatos
    .map((c) => ({ variantes: phoneLookupVariants(`+${c.waId}`), nome: c.nome?.trim() ?? "" }))
    .filter((c) => c.nome && c.variantes.length > 0);
  let processados = 0;
  for (let i = 0; i < comNome.length; i += PARALELO) {
    const lote = comNome.slice(i, i + PARALELO);
    const rs = await Promise.all(
      lote.map((c) =>
        admin
          .from("contacts")
          .update({ display_name: c.nome })
          .eq("organization_id", organizationId)
          .is("is_merged_into", null)
          .in("phone_number", c.variantes)
          .or("display_name.is.null,display_name.eq.")
          .select("id"),
      ),
    );
    for (const { data, error } of rs) {
      if (error) logger.error("[meta.contatos] nome do contato não gravado", { detail: error.message });
      else processados += data?.length ?? 0;
    }
  }
  return { processados };
}
