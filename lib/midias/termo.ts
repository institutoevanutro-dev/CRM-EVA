/**
 * A regra "esta mídia pode sair?" da biblioteca (spec 2026-10-06, §2.5).
 * Usada pela tela (fatia 1), pelo prompt e pelo handler de envio (fatias 2-4).
 * O handler é a trava; tela e prompt são conveniência.
 */

export const BUCKET_DA_BIBLIOTECA = "media-library";
export const TIPOS_ACEITOS_NA_BIBLIOTECA = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/3gpp"] as const;

export type Variante = { key: "A" | "B"; storage_path: string; mime: string; size_bytes: number };
export type ItemDeMidia = {
  contains_person: boolean;
  consent_signed_at: string | null;
  consent_expires_at: string | null;
  consent_revoked_at: string | null;
  variants: Variante[];
};
export type SituacaoDaMidia = "pronta" | "arquivo_ausente" | "sem_termo" | "termo_vencido" | "revogada";

export function situacaoDaMidia(item: ItemDeMidia, hoje: string): SituacaoDaMidia {
  if (item.variants.length === 0) return "arquivo_ausente";
  if (!item.contains_person) return "pronta";
  if (item.consent_revoked_at) return "revogada";
  if (!item.consent_signed_at) return "sem_termo";
  if (item.consent_expires_at && item.consent_expires_at < hoje) return "termo_vencido";
  return "pronta";
}

// ponytail: fuso fixo de São Paulo; trocar pelo fuso da organização quando houver cliente fora dele.
export function hojeNaClinica(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

export const SITUACAO_LEGIVEL: Record<SituacaoDaMidia, string> = {
  pronta: "pronta",
  sem_termo: "sem termo de uso de imagem",
  termo_vencido: "termo vencido",
  revogada: "termo revogado",
  arquivo_ausente: "sem arquivo",
};
