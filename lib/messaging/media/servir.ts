/**
 * Cabeçalhos para servir mídia de mensagem — cujo tipo foi declarado pelo
 * REMETENTE (o contato no WhatsApp), não por nós.
 *
 * Servir `text/html`, `image/svg+xml` ou afins na origem do CRM é XSS
 * armazenado: o script roda logado como o atendente que clicou em "Baixar"
 * (auditoria 2026-09-29, C3). Então só um conjunto fechado de tipos inertes sai
 * inline; todo o resto vira `application/octet-stream` + `attachment`.
 *
 * PDF sai inline SEM `sandbox`: o visualizador de PDF do Chrome se recusa a
 * abrir documento sandboxed, e o JS de PDF roda na origem do visualizador, não
 * na nossa. Os demais levam `sandbox` como segunda trava.
 */
const INLINE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/3gpp",
  "video/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/webm",
  "application/pdf",
]);

export function cabecalhosDeMidia(mime: string | null | undefined): Record<string, string> {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  const inline = INLINE.has(base);
  return {
    "Content-Type": inline ? base : "application/octet-stream",
    "Content-Disposition": inline ? "inline" : "attachment",
    "X-Content-Type-Options": "nosniff",
    ...(base === "application/pdf" && inline
      ? {}
      : { "Content-Security-Policy": "sandbox; default-src 'none'" }),
  };
}

/** O Content-Type com que a mídia é GUARDADA no Storage — mesma régua. */
export function tipoParaGuardar(mime: string | null | undefined): string {
  return cabecalhosDeMidia(mime)["Content-Type"]!;
}
