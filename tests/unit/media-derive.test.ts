import { describe, expect, it, vi } from "vitest";

import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";

function deps(over: Partial<DeriveDeps> = {}): DeriveDeps {
  return {
    transcriber: { transcribe: vi.fn(async () => "transcrição do áudio") },
    describeImage: vi.fn(async () => "uma foto de um tênis vermelho"),
    extractPdf: vi.fn(async () => "conteúdo do pdf"),
    ...over,
  };
}

describe("deriveMediaText", () => {
  it("audio → transcrição", async () => {
    expect(await deriveMediaText("audio", Buffer.from([1]), "audio/ogg", deps())).toBe(
      "transcrição do áudio",
    );
  });
  it("document pdf → texto extraído", async () => {
    expect(
      await deriveMediaText("document", Buffer.from([1]), "application/pdf", deps()),
    ).toBe("conteúdo do pdf");
  });
  it("image → descrição por visão", async () => {
    expect(await deriveMediaText("image", Buffer.from([1]), "image/jpeg", deps())).toBe(
      "uma foto de um tênis vermelho",
    );
  });
  it("document NÃO-pdf → vazio (sem extrator)", async () => {
    expect(await deriveMediaText("document", Buffer.from([1]), "text/csv", deps())).toBe("");
  });
  it("tipo sem derivação (sticker/video) → vazio", async () => {
    expect(await deriveMediaText("sticker", Buffer.from([1]), "image/webp", deps())).toBe("");
    expect(await deriveMediaText("video", Buffer.from([1]), "video/mp4", deps())).toBe("");
  });
  /**
   * PDF ESCANEADO (só imagem) — o caso mais comum numa clínica: o paciente
   * fotografa o comprovante e manda em PDF. A extração de texto não acha nada,
   * e antes disto o derivado morria ali: 5 tentativas, aviso CRÍTICO na Central
   * e a IA sem ver o arquivo. Agora o PDF vai para a visão, o mesmo caminho da
   * foto (medido em produção no Instituto Eva, 2026-09-22).
   */
  it("pdf sem texto (escaneado) → a visão lê o arquivo", async () => {
    const descrever = vi.fn(async () => "comprovante de Pix de R$ 200 para a clínica");
    const out = await deriveMediaText("document", Buffer.from([1]), "application/pdf", deps({
      extractPdf: vi.fn(async () => {
        throw new Error("pdfjs-dist extracted no text (possibly image-only PDF)");
      }),
      describeImage: descrever,
    }));
    expect(out).toBe("comprovante de Pix de R$ 200 para a clínica");
    expect(descrever).toHaveBeenCalledWith(expect.anything(), "application/pdf");
  });

  it("pdf escaneado com visão indisponível → devolve o motivo, sem lançar", async () => {
    const out = await deriveMediaText("document", Buffer.from([1]), "application/pdf", deps({
      extractPdf: vi.fn(async () => {
        throw new Error("pdfjs-dist extracted no text (possibly image-only PDF)");
      }),
      describeImage: vi.fn(async () => "[o cliente enviou uma mídia que não consegui interpretar]"),
    }));
    expect(out).toBe("[o cliente enviou uma mídia que não consegui interpretar]");
  });

  it("pdf que falha por OUTRA causa continua lançando — não é caso de visão", async () => {
    const descrever = vi.fn(async () => "não deveria ser chamada");
    await expect(
      deriveMediaText("document", Buffer.from([1]), "application/pdf", deps({
        extractPdf: vi.fn(async () => {
          throw new Error("Extração de PDF indisponível: o binário nativo @napi-rs/canvas não foi instalado");
        }),
        describeImage: descrever,
      })),
    ).rejects.toThrow(/@napi-rs\/canvas/);
    expect(descrever).not.toHaveBeenCalled();
  });

  it("trunca derivado gigante a 8000 chars", async () => {
    const huge = "a".repeat(20000);
    const out = await deriveMediaText("document", Buffer.from([1]), "application/pdf", deps({
      extractPdf: vi.fn(async () => huge),
    }));
    expect(out.length).toBe(8000);
  });
});
