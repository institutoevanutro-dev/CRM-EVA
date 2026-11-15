/**
 * A ORIGEM DO GOOGLE ADS que a ficha mostra — campanha, grupo, anúncio,
 * palavra-chave e conta, lidos de `source_metadata`.
 *
 * Porte do DeskcommCRM (PR #4631 de @SerusoNakamoto), recortado: lá isto é parte
 * de `origemDoContato`, que também lê UTM de site e a hierarquia da Meta; o fork
 * não tem essa régua, então aqui só o caso Google, e só quando a plataforma foi
 * PROVADA pelo clique (`ad_platform` ou `source` = `google_ads`). UTM solta não
 * prova a plataforma.
 *
 * O nome vem acompanhado do ID quando os dois existem e diferem: campanhas e
 * anúncios homônimos só se distinguem pelo ID. Os valores passam pela mesma
 * validação da captura, para dado legado malformado não aparecer na tela.
 */
import {
  CHAVES_DE_METADADOS_GOOGLE,
  normalizarMetadadosGoogle,
} from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";

export interface OrigemGoogleAds {
  campanha: string | null;
  grupo: string | null;
  anuncio: string | null;
  palavraChave: string | null;
  conta: string | null;
}

function comId(rotulo: string | undefined, id: string | undefined): string | null {
  if (rotulo && id && rotulo !== id) return `${rotulo} (${id})`;
  return rotulo ?? id ?? null;
}

export function origemGoogleAds(
  metadata: Record<string, unknown> | null | undefined,
  source: string | null | undefined,
): OrigemGoogleAds | null {
  const meta = metadata ?? {};
  if ((meta.ad_platform ?? source) !== "google_ads") return null;
  const d = normalizarMetadadosGoogle(
    Object.fromEntries(CHAVES_DE_METADADOS_GOOGLE.map((chave) => [chave, meta[chave]])),
  );
  return {
    campanha: comId(d.utm_campaign, d.google_campaign_id),
    grupo: comId(d.utm_adset, d.google_adgroup_id),
    anuncio: comId(d.utm_ad ?? d.utm_content, d.google_ad_id),
    palavraChave: d.utm_term ?? null,
    conta: d.google_customer_id ?? null,
  };
}
