import { execFile } from "node:child_process";
import { join } from "node:path";

export const PDF_SEM_TEXTO = "pdfjs-dist extracted no text (possibly image-only PDF)";

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractError";
  }
}

let activeParsers = 0;

/** Parsing is isolated, killed after 30s and limited to 128 MiB of V8 heap.
 * Native allocations are additionally bounded by the deployment's container limit. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (buffer.length > 50 * 1024 * 1024) throw new PdfExtractError("pdf_input_limit");
  if (activeParsers >= 2) throw new PdfExtractError("Processamento de PDF ocupado; tente novamente.");
  activeParsers++;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [
      "--max-old-space-size=128", join(process.cwd(), "lib/ai/rag/extractors/pdf-worker.mjs"),
    ], { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      activeParsers--;
      if (error) {
        reject(new PdfExtractError("PDF excedeu o limite de processamento ou não pôde ser lido."));
        return;
      }
      try {
        const result = JSON.parse(stdout) as { text?: string; error?: string };
        if (result.error === "image_only") throw new PdfExtractError(PDF_SEM_TEXTO);
        if (result.error === "canvas_missing") {
          throw new PdfExtractError("Extração de PDF indisponível: reinstale as dependências opcionais de @napi-rs/canvas.");
        }
        if (result.error || typeof result.text !== "string") {
          throw new PdfExtractError("PDF inválido ou acima do limite de 200 páginas / 1 milhão de caracteres.");
        }
        resolve(result.text);
      } catch (error) {
        reject(error instanceof PdfExtractError ? error : new PdfExtractError("Falha ao extrair texto do PDF."));
      }
    });
    // A parser killed for timeout/heap limits may close stdin before all bytes arrive.
    child.stdin?.on("error", () => {});
    child.stdin?.end(buffer);
  });
}
