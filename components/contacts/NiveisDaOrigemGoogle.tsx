"use client";
/**
 * Os níveis da origem do Google Ads, como pares `dt`/`dd` para um `<dl>` que já
 * existe. Nível sem valor não aparece: travessões seguidos leem como cadastro
 * quebrado, e não como "o link não trouxe este campo". Porte do DeskcommCRM #4631.
 */
import { useT } from "@/hooks/i18n/useT";
import type { OrigemGoogleAds } from "@/lib/leads/origem-google-ads";

function Nivel({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1 break-words">{valor}</dd>
    </div>
  );
}

export function NiveisDaOrigemGoogle({ origem }: { origem: OrigemGoogleAds }) {
  const t = useT();
  return (
    <>
      <Nivel rotulo={t("Campanha")} valor={origem.campanha} />
      <Nivel rotulo={t("Grupo de anúncios")} valor={origem.grupo} />
      <Nivel rotulo={t("Anúncio")} valor={origem.anuncio} />
      <Nivel rotulo={t("Palavra-chave")} valor={origem.palavraChave} />
      <Nivel rotulo={t("Conta do Google Ads")} valor={origem.conta} />
    </>
  );
}
