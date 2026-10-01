/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { farejarTipo, pareceSvg } from "@/lib/branding/logo-arquivo";
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

const NAO_SUPORTADO: Fail = {
  ok: false,
  code: "unsupported_media_type",
  message: "Tipo de arquivo não suportado.",
};

/** Imagem que o canal aceita, reconhecida pela assinatura dos bytes. */
function ehImagemDeVerdade(b: Uint8Array): boolean {
  if (farejarTipo(b)) return true; // PNG, JPEG
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  return ascii(0, 4) === "GIF8" || (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP");
}

/** HTML/SVG/XML que um navegador executaria — em qualquer rótulo. */
function pareceMarcacao(b: Uint8Array): boolean {
  if (pareceSvg(b)) return true;
  let texto = "";
  for (const x of b.subarray(0, 1024)) texto += String.fromCharCode(x);
  return /<\s*(!doctype\s+html|html|script|body|iframe)[\s>]/i.test(texto);
}

/**
 * `bytes` é o conteúdo real: o `file.type` é do cliente e mente quando quer
 * (auditoria 2026-09-29, C3 — um SVG rotulado `image/png` subia como imagem).
 */
export function validateOutboundMedia(mime: string, sizeBytes: number, bytes?: Uint8Array): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base === "image/svg+xml") return NAO_SUPORTADO;
  if (bytes) {
    const texto = base === "text/plain" || base === "text/csv";
    if (!texto && pareceMarcacao(bytes)) return NAO_SUPORTADO;
    if (base.startsWith("image/") && !ehImagemDeVerdade(bytes)) return NAO_SUPORTADO;
  }
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return NAO_SUPORTADO;
}
