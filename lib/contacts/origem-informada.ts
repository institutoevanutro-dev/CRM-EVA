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
