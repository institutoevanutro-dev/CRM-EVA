/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * Posse do objeto no bucket: o path DEVE ser {org}/{conversation}/<arquivo>,
 * com um único nome de arquivo depois do prefixo.
 *
 * "Chaves do Storage são literais" é verdade no Storage, mas não no caminho até
 * ele: o storage-js monta `/object/sign/<bucket>/<path>` sem codificar, e o
 * `fetch` resolve `..` (e `%2e%2e`, e `\`) antes de a requisição sair. Um
 * `{org}/{conv}/../../<outraOrg>/...` passava no `startsWith` e a service role
 * assinava o arquivo de outra organização. Por isso o nome do arquivo só aceita
 * letras, números, `.`, `_` e `-`, e nunca `.` ou `..` sozinhos.
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  const prefixo = `${orgId}/${conversationId}/`;
  if (!path.startsWith(prefixo)) return false;
  const arquivo = path.slice(prefixo.length);
  return /^[A-Za-z0-9._-]+$/.test(arquivo) && arquivo !== "." && arquivo !== "..";
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}
