/**
 * O PROXY NÃO PODE CORTAR O UPLOAD ANTES DO TETO DA ROTA.
 *
 * Com `proxy.ts` no caminho, o Next limita o corpo da requisição a 10 MB e
 * entrega o resto truncado. Em produção (09/10/2026) um vídeo de celular
 * enviado pelo "+" da conversa voltou "Unable to read upload.", com o log
 * "Request body exceeded 10MB for /api/v1/conversations/.../media", embora a
 * rota aceite até 50 MB (`MAX_MEDIA_BYTES`) mais 1 MB de multipart.
 */
import { describe, expect, it } from "vitest";

import nextConfig from "@/next.config";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

describe("o teto do proxy cobre o upload de mídia", () => {
  it("proxyClientMaxBodySize ≥ 50 MB + overhead do multipart", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBeGreaterThanOrEqual(
      MAX_MEDIA_BYTES + 1_048_576,
    );
  });
});
