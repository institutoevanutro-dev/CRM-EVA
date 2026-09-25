/**
 * Resolve a conexão pela conta do Instagram (entry.id do webhook do APP).
 * É a raiz do roteamento: ainda não se sabe a organização, e o índice único
 * `uniq_channel_sessions_ig_account_ativa` garante uma linha ativa por conta.
 * Toda consulta DEPOIS desta usa o organization_id devolvido aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessaoDoInstagram } from "./ingest";

export async function sessaoDoInstagramPorConta(admin: SupabaseClient, igAccountId: string): Promise<SessaoDoInstagram | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, ig_account_id, ig_token_encrypted, metadata")
    .eq("provider", "meta_instagram")
    .eq("ig_account_id", igAccountId)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const linha = data as { id: string; organization_id: string; ig_account_id: string; ig_token_encrypted: string | null; metadata: Record<string, unknown> | null };
  const origem = linha.metadata?.origem_padrao as { campo?: string; valor?: string } | undefined;
  return {
    id: linha.id,
    organizationId: linha.organization_id,
    igAccountId: linha.ig_account_id,
    tokenCifrado: linha.ig_token_encrypted,
    origemPadrao: origem?.campo && origem?.valor ? { campo: origem.campo, valor: origem.valor } : null,
  };
}
