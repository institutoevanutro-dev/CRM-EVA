import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { MediaTooLargeError } from "@/lib/messaging/media/types";

const WAHA_BASE = "http://localhost:3030";

describe("fetchWahaMedia", () => {
  beforeEach(() => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("baixa a mídia com X-Api-Key e retorna buffer + mime", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const media = await fetchWahaMedia(`${WAHA_BASE}/api/files/default/abc.jpg`, null, "default");
    expect(media.mime).toBe("image/jpeg");
    expect(media.buffer.byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      `${WAHA_BASE}/api/files/default/abc.jpg`,
      expect.objectContaining({ headers: { "X-Api-Key": "hash123" } }),
    );
  });

  it("reescreve host arbitrário p/ a base do WAHA (anti-SSRF por construção)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new ArrayBuffer(2), { status: 200, headers: { "content-type": "image/jpeg" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWahaMedia("http://evil.example.com/api/files/default/x.jpg?q=1", null, "default");
    expect(fetchMock).toHaveBeenCalledWith(
      `${WAHA_BASE}/api/files/default/x.jpg`,
      expect.anything(),
    );
  });

  it("reescreve a porta interna anunciada pelo WAHA p/ a base real", async () => {
    // WAHA anuncia localhost:3000 (porta interna do container); no host é 3030.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new ArrayBuffer(2), { status: 200, headers: { "content-type": "image/webp" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWahaMedia("http://localhost:3000/api/files/sessao/sticker.webp", null, "sessao");
    expect(fetchMock).toHaveBeenCalledWith(
      `${WAHA_BASE}/api/files/sessao/sticker.webp`,
      expect.anything(),
    );
  });

  it("propaga status HTTP de erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchWahaMedia(`${WAHA_BASE}/api/files/default/gone.jpg`, null, "default")).rejects.toThrow(
      "waha_media_404",
    );
  });

  it("rejeita mídia acima de 50MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ArrayBuffer(8), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(60 * 1024 * 1024) },
        }),
      ),
    );
    await expect(fetchWahaMedia(`${WAHA_BASE}/api/files/default/big.mp4`, null, "default")).rejects.toThrow(
      MediaTooLargeError,
    );
  });

  it("usa hintMime quando o content-type vem vazio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new ArrayBuffer(2), { status: 200 })),
    );
    const media = await fetchWahaMedia(`${WAHA_BASE}/api/files/default/x`, "audio/ogg; codecs=opus", "default");
    expect(media.mime).toBe("audio/ogg; codecs=opus");
  });

  it("mapeia mediaUrl malformada p/ waha_media_untrusted_host", async () => {
    await expect(fetchWahaMedia("not-a-url", null, "default")).rejects.toThrow("waha_media_untrusted_host");
  });

  // C4 (auditoria 2026-09-29): a URL podia vir do corpo da API de envio, e o
  // path+query sobreviviam — `GET /api/sessions` com a X-Api-Key global.
  describe("só o diretório de arquivos da PRÓPRIA sessão", () => {
    it.each([
      "http://x/api/sessions",
      "http://x/api/default/chats",
      "http://x/api/files/outra/x.jpg",
      "http://x/api/files/default/../../api/sessions",
      "http://x/api/files/default/%2e%2e/x",
      "http://x/api/files/default/sub/x.jpg",
      "http://x/api/files/default/",
    ])("recusa %s sem chamar o WAHA", async (u) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchWahaMedia(u, null, "default")).rejects.toThrow("waha_media_untrusted_path");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("aceita o nome de arquivo real do WAHA (id com @ e _)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(1), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      await fetchWahaMedia(
        "http://localhost:3000/api/files/default/false_5511999999999@c.us_3EB0C767D26A1D8B.oga",
        null,
        "default",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${WAHA_BASE}/api/files/default/false_5511999999999@c.us_3EB0C767D26A1D8B.oga`,
        expect.anything(),
      );
    });
  });
});
