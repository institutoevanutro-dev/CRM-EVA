import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Devolve ao eco do celular preso em OUTRA conversa o id que o canal entregou
 * para ele, liberando o id curto para a linha do envio do CRM.
 *
 * O caso: a mesma pessoa cadastrada duas vezes (telefone e @lid). O eco do
 * envio cai na outra conversa gravado com o id curto — a forma canônica, a
 * mesma do envio — e a limpeza do eco, que é só da conversa do envio de
 * propósito, não o alcança. O carimbo do id colide no unique e a linha do envio
 * ficava sem id: sem entregue/lida, sem citação, sem edição.
 *
 * Não apaga nada e não mexe na conversa do envio (lá quem resolve é a limpeza).
 * Só toca linha do celular (`external_device`) que guardou o composto em
 * `metadata.external_id_original` (a ingestão do canal) — e devolvê-lo é o
 * estado exato de antes de o eco passar a gravar o id curto: o ack segue
 * casando as duas linhas, pelo composto e pelo curto.
 *
 * BLINDADO: a mensagem já saiu. Falhar aqui só deixa o desfecho de antes
 * (`sent` sem o id). Devolve `true` quando liberou algum id.
 */
export async function devolverIdOriginalAoEcoDeOutraConversa(
  db: SupabaseClient,
  organizationId: string,
  minhaLinhaId: string,
  candidatos: string[],
): Promise<boolean> {
  if (candidatos.length === 0) return false;
  try {
    const { data: minha } = await db
      .from("messages")
      .select("conversation_id")
      .eq("organization_id", organizationId)
      .eq("id", minhaLinhaId)
      .maybeSingle();
    const conversa = (minha as { conversation_id?: string } | null)?.conversation_id;
    if (!conversa) return false;

    const { data: ecos } = await db
      .from("messages")
      .select("id, external_id, metadata")
      .eq("organization_id", organizationId)
      .eq("sent_via", "external_device")
      .in("external_id", candidatos)
      .neq("conversation_id", conversa);

    let liberou = false;
    for (const eco of (ecos ?? []) as Array<{ id: string; external_id: string; metadata: Record<string, unknown> | null }>) {
      const original = eco.metadata?.external_id_original;
      if (typeof original !== "string" || original === eco.external_id) continue;
      const { error } = await db
        .from("messages")
        .update({ external_id: original })
        .eq("organization_id", organizationId)
        .eq("id", eco.id)
        .eq("external_id", eco.external_id);
      if (!error) liberou = true;
    }
    return liberou;
  } catch {
    return false;
  }
}
