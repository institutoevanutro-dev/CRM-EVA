/**
 * Helpers puros da renderização de mídia no inbox (Onda 1).
 * A mídia é SEMPRE servida por /api/v1/messages/{id}/media (Onda 0) —
 * o browser segue o 302 pra signed URL; nunca usar media_url do WAHA.
 */
import { nomeDeArquivoLimpo } from "@/lib/messaging/media/nome-de-arquivo";

export function mediaSrc(messageId: string): string {
  return `/api/v1/messages/${messageId}/media`;
}

/**
 * Nome ORIGINAL do documento quando a ingestão o guardou em
 * `metadata.media_filename`. O path de storage é canônico
 * (`{org}/{conversa}/{mensagem}.{ext}`) e não guarda o nome que o cliente
 * mandou; sem esta chave o cartão cai no rótulo de extensão.
 */
export function nomeOriginalDoDocumento(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  return nomeDeArquivoLimpo((metadata as Record<string, unknown>).media_filename);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}

/** Rótulo do arquivo: nome original > extensão do path ("PDF") > sufixo do mime > "Arquivo". */
export function mediaFileLabel(
  mime: string | null,
  storagePath: string | null,
  fileName?: string | null,
): string {
  const nome = fileName?.trim();
  if (nome) return nome;
  const ext = storagePath?.split(".").pop()?.toLowerCase();
  if (ext && ext !== "bin") return ext.toUpperCase();
  const sub = mime?.split(";")[0]?.split("/")[1]?.toLowerCase();
  if (sub && !["octet-stream", "bin"].includes(sub)) return sub.toUpperCase();
  return "Arquivo";
}
