/**
 * Código de clique do Google Ads embutido na mensagem do WhatsApp.
 *
 * Clique em anúncio do Google que abre o WhatsApp não traz `gclid` até aqui.
 * O site captura o id do clique, gera um código curto e grava o par pela rota
 * pública `POST /api/v1/publico/clique-google/{token}`; a mensagem pré-preenchida
 * termina com "Cód. ABC123". Quando ela chega, este módulo acha o código,
 * consome a linha (uma vez só, de forma atômica) e estampa o contato como
 * `google_ads` pelo caminho de primeiro toque que já existe
 * (`estamparAtribuicaoDoContato`). Daí em diante o despacho de conversão
 * existente manda o clique ao Google.
 *
 * Agnóstico de canal: quem chama é o ingest de cada transporte, com o texto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { logger } from "@/lib/logger";

/** Alfabeto sem 0/O/1/I, como o site gera. */
export const PADRAO_DO_CODIGO = /^[A-HJ-NP-Z2-9]{6}$/;
const NA_MENSAGEM = /C[óo]d\.?\s*([A-HJ-NP-Z2-9]{6})\b/i;
export const VALIDADE_DO_CODIGO_DIAS = 90;
export type TipoDeClique = "gclid" | "gbraid" | "wbraid";
export const TIPOS_DE_CLIQUE: readonly TipoDeClique[] = ["gclid", "gbraid", "wbraid"];

export function codigoNaMensagem(texto: string | null | undefined): string | null {
  const achado = texto ? NA_MENSAGEM.exec(texto) : null;
  return achado ? achado[1]!.toUpperCase() : null;
}

/**
 * Best-effort: qualquer falha vira log e a mensagem segue entrando. Retorna
 * `true` quando estampou (ou tentou estampar) o contato.
 */
export async function aplicarCodigoDeCliqueGoogle(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  texto: string | null | undefined,
): Promise<boolean> {
  const codigo = codigoNaMensagem(texto);
  if (!codigo) return false;

  const desde = new Date(Date.now() - VALIDADE_DO_CODIGO_DIAS * 86_400_000).toISOString();
  // Consumo atômico: o `used_at is null` no WHERE garante uma vez só, mesmo com
  // a mesma mensagem re-entregue ou duas mensagens com o mesmo código.
  const { data, error } = await admin
    .from("google_click_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("code", codigo)
    .is("used_at", null)
    .gte("created_at", desde)
    .select("click_id_kind, click_id, landing_url, clicked_at")
    .maybeSingle();

  if (error) {
    logger.error("[codigo-de-clique-google] falha ao consumir código", { organizationId, error: error.message });
    return false;
  }
  if (!data) return false;

  const tipo = data.click_id_kind as TipoDeClique;
  await estamparAtribuicaoDoContato(admin, contactId, {
    plataforma: "google_ads",
    sourceId: null,
    titulo: null,
    corpo: null,
    sourceUrl: typeof data.landing_url === "string" ? data.landing_url : null,
    bruto: { [tipo]: data.click_id, codigo, clicked_at: data.clicked_at },
  });
  return true;
}
