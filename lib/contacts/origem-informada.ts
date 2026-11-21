/**
 * "Como chegou": a origem que a recepção informa na ficha do contato.
 *
 * Mora em `contacts.source_metadata.origem_informada` — este módulo é o único
 * lugar que conhece a chave e o vocabulário (o schema do PATCH, o diálogo da
 * ficha e o funil por origem do Marketing importam daqui). A marca automática
 * do anúncio (`source_metadata.ad_platform`) continua acima dela no funil.
 */
export const ORIGENS_INFORMADAS = ["meta", "google", "indicacao", "organico"] as const;
export type OrigemInformada = (typeof ORIGENS_INFORMADAS)[number];

export const ROTULO_DA_ORIGEM_INFORMADA: Record<OrigemInformada, string> = {
  meta: "Anúncio Meta",
  google: "Anúncio Google",
  indicacao: "Indicação",
  organico: "Orgânico",
};

export const CHAVE_ORIGEM_INFORMADA = "origem_informada";

export function origemInformadaDe(sourceMetadata: unknown): OrigemInformada | null {
  const v = (sourceMetadata as Record<string, unknown> | null)?.[CHAVE_ORIGEM_INFORMADA];
  return (ORIGENS_INFORMADAS as readonly unknown[]).includes(v) ? (v as OrigemInformada) : null;
}

const semAcento = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

/**
 * A ORIGEM do contato, na ordem que o funil por origem do Marketing usa: a marca
 * automática do anúncio, depois o "Como chegou" informado, depois as etiquetas
 * (e a origem dos leads), e por fim orgânico. Mora aqui, e não no funil, para a
 * tela de marcação mostrar a mesma origem que o funil conta.
 */
export function origemDe({
  adPlatform,
  tags,
  informada = null,
}: {
  adPlatform: string | null;
  tags: string[];
  informada?: OrigemInformada | null;
}): OrigemInformada {
  if (adPlatform === "meta_ads") return "meta";
  if (adPlatform === "google_ads") return "google";
  // "Como chegou", escolhido na ficha do contato: vale acima das etiquetas.
  if (informada) return informada;
  // Correção à mão (18/11): sem a marca automática do anúncio, a recepção põe a etiqueta "Meta" ou
  // "Google" (ou "Anúncio Meta"/"Anúncio Google") no lead de quem disse que veio do anúncio.
  const t = tags.map(semAcento);
  if (t.some((x) => x === "meta" || x === "anuncio meta")) return "meta";
  if (t.some((x) => x === "google" || x === "anuncio google")) return "google";
  // `tags` leva também a origem (`source`) dos leads do contato.
  if (t.some((x) => x === "indicacao")) return "indicacao";
  return "organico";
}
