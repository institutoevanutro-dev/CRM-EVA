/**
 * Resolve a conexão pela conta do Instagram (entry.id do webhook do APP).
 * É a raiz do roteamento: ainda não se sabe a organização, e o índice único
 * `uniq_channel_sessions_ig_account_ativa` garante uma linha ativa por conta.
 * Toda consulta DEPOIS desta usa o organization_id devolvido aqui.
 *
 * O retorno distingue "conta sem conexão ativa" (rotina — o webhook do app
 * recebe entrega para toda conta configurada na Meta, conectada ou não) de
 * "a consulta falhou" (incidente — banco fora do ar, permissão, timeout). As
 * duas eram a mesma coisa (`null`) e o chamador logava as duas como `info`,
 * escondendo um DB fora do ar atrás de uma mensagem de rotina.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessaoDoInstagram } from "./ingest";

export type ResultadoDaSessaoDoInstagram =
  | { status: "ok"; sessao: SessaoDoInstagram }
  | { status: "ausente" }
  | { status: "erro"; motivo: string };

export async function sessaoDoInstagramPorConta(admin: SupabaseClient, igAccountId: string): Promise<ResultadoDaSessaoDoInstagram> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, ig_account_id, ig_token_encrypted, metadata")
    .eq("provider", "meta_instagram")
    .eq("ig_account_id", igAccountId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return { status: "erro", motivo: error.message };
  if (!data) return { status: "ausente" };
  const linha = data as { id: string; organization_id: string; ig_account_id: string; ig_token_encrypted: string | null; metadata: Record<string, unknown> | null };
  const origem = linha.metadata?.origem_padrao as { campo?: string; valor?: string } | undefined;
  return {
    status: "ok",
    sessao: {
      id: linha.id,
      organizationId: linha.organization_id,
      igAccountId: linha.ig_account_id,
      tokenCifrado: linha.ig_token_encrypted,
      origemPadrao: origem?.campo && origem?.valor ? { campo: origem.campo, valor: origem.valor } : null,
    },
  };
}
