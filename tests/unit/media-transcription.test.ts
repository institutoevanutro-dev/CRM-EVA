import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

describe("apiTranscriptionProvider", () => {
  it("POSTa multipart pro endpoint de transcrição e devolve o texto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "olá, quero comprar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("olá, quero comprar");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  /**
   * O IDIOMA VAI JUNTO COM O ÁUDIO.
   *
   * Sem ele o Whisper adivinha, e adivinha mal em áudio curto: medido em
   * produção (Instituto Eva, 2026-09-22), "testando 123 testando" virou
   * "3102 reis 3101". O idioma sai de `organizations.locale`.
   */
  it("manda o idioma da organização no pedido", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "testando 123 testando" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test", language: "pt" }, fetchMock);
    await provider.transcribe(Buffer.from([1]), "audio/ogg");
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get("language")).toBe("pt");
  });

  it("sem idioma configurado, não inventa um campo vazio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    await provider.transcribe(Buffer.from([1]), "audio/ogg");
    expect((fetchMock.mock.calls[0]![1].body as FormData).has("language")).toBe(false);
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = apiTranscriptionProvider({ apiKey: "bad" }, fetchMock);
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(/transcription_401/);
  });
});
