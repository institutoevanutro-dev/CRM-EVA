/**
 * `fetchInboundMedia` do Instagram — a mídia recebida NÃO PODE seguir cega o
 * host que o payload do webhook mandar (SSRF), e não pode ficar sem teto de
 * tamanho (o mesmo que os outros canais respeitam, `MAX_MEDIA_BYTES`).
 *
 * O guard é em DUAS camadas, e os casos abaixo provam as duas:
 *   1. allowlist de host por SUFIXO (textual, antes de qualquer rede);
 *   2. resolução de DNS real (`assertDestinoResolvidoSeguro`), que pega um
 *      host que resolve para IP privado NO MOMENTO do fetch — por isso os
 *      hosts de teste são domínios PÚBLICOS de verdade (mesmo padrão de
 *      `tests/unit/channel-adapter-zernio.test.ts`), com `fetch` mockado.
 *
 * O que se prova é COMPORTAMENTO — `fetch` não chamado — e não só a exceção:
 * um guard que lançasse DEPOIS do fetch já teria vazado a tentativa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { instagramAdapter } from "@/lib/channels/adapters/instagram";

const ORG = "00000000-0000-4000-8000-000000000287";

function corpoOk(bytes: number, contentType = "image/jpeg") {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes) }),
    arrayBuffer: async () => new ArrayBuffer(bytes),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("fetchInboundMedia do Instagram", () => {
  it("baixa de um host permitido (sufixo .cdninstagram.com)", async () => {
    corpoOk(4);
    const r = await instagramAdapter.fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: "178414",
      url: "https://scontent.cdninstagram.com/v/t51/foto.jpg",
    });
    expect(r.mime).toBe("image/jpeg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("baixa de lookaside.fbsbx.com (host real relatado em payload de mensagem)", async () => {
    corpoOk(4);
    const r = await instagramAdapter.fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: "178414",
      url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123&signature=abc",
    });
    expect(r.mime).toBe("image/jpeg");
  });

  it("recusa host fora da allowlist — sem chamar fetch", async () => {
    await expect(
      instagramAdapter.fetchInboundMedia!({
        organizationId: ORG,
        sessionRef: "178414",
        url: "https://evil.example.com/malware.jpg",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa http:// mesmo num host da allowlist — sem chamar fetch", async () => {
    await expect(
      instagramAdapter.fetchInboundMedia!({
        organizationId: ORG,
        sessionRef: "178414",
        url: "http://scontent.cdninstagram.com/foto.jpg",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa IP privado literal — sem chamar fetch", async () => {
    await expect(
      instagramAdapter.fetchInboundMedia!({
        organizationId: ORG,
        sessionRef: "178414",
        url: "https://169.254.169.254/latest/meta-data/",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("corpo maior que o teto (MAX_MEDIA_BYTES) é recusado, mesmo host permitido", async () => {
    const { MAX_MEDIA_BYTES } = await import("@/lib/messaging/media/types");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(MAX_MEDIA_BYTES + 1) }),
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    await expect(
      instagramAdapter.fetchInboundMedia!({
        organizationId: ORG,
        sessionRef: "178414",
        url: "https://scontent.cdninstagram.com/video.mp4",
      }),
    ).rejects.toThrow(/media exceeds/);
  });
});
