/**
 * Derivação textual de mídia (Onda 3, camada UNIVERSAL). Puro: as capacidades
 * (transcrição, visão, extração de pdf) são injetadas — o worker as monta com as
 * credenciais BYOK da org. O resultado é texto que qualquer modelo de chat lê.
 */
import { PDF_SEM_TEXTO } from "@/lib/ai/rag/extractors/pdf";
import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";

const MAX_DERIVED_CHARS = 8000;

export interface DeriveDeps {
  transcriber: TranscriptionProvider;
  describeImage(buffer: Buffer, mime: string): Promise<string>;
  extractPdf(buffer: Buffer): Promise<string>;
  /** Onda 3.1: derivação de vídeo (ffmpeg → áudio+frames). Ausente = vídeo não derivado. */
  deriveVideo?: (buffer: Buffer, mime: string) => Promise<string>;
}

export async function deriveMediaText(
  kind: string,
  buffer: Buffer,
  mime: string,
  deps: DeriveDeps,
): Promise<string> {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  let text = "";
  if (kind === "audio") {
    text = await deps.transcriber.transcribe(buffer, mime);
  } else if (kind === "document" && base === "application/pdf") {
    text = await extrairPdfOuOlhar(buffer, base, deps);
  } else if (kind === "image") {
    text = await deps.describeImage(buffer, mime);
  } else if (kind === "video" && deps.deriveVideo) {
    text = await deps.deriveVideo(buffer, mime);
  }
  // sticker/document-não-pdf (e vídeo sem deriveVideo): sem derivado.
  return (text ?? "").slice(0, MAX_DERIVED_CHARS);
}

/**
 * PDF ESCANEADO — o comprovante que o paciente fotografou e mandou em PDF.
 *
 * A extração de texto não acha nada nele, e até 2026-09-22 isso era o fim da
 * linha: o worker tentava 5 vezes, abria aviso CRÍTICO na Central e a IA nunca
 * via o arquivo (medido em produção, Instituto Eva). O arquivo em si é legível
 * — por visão, o mesmo caminho da foto —, então é para lá que ele vai.
 *
 * SÓ o caso "sem texto" cai aqui. Qualquer outra falha (dependência ausente,
 * PDF corrompido) continua subindo: ela é problema da instalação, e trocá-la
 * por uma chamada de visão esconderia o defeito e gastaria crédito à toa.
 */
async function extrairPdfOuOlhar(buffer: Buffer, mime: string, deps: DeriveDeps): Promise<string> {
  try {
    return await deps.extractPdf(buffer);
  } catch (erro) {
    const semTexto = erro instanceof Error && erro.message.includes(PDF_SEM_TEXTO);
    if (!semTexto) throw erro;
    return await deps.describeImage(buffer, mime);
  }
}
