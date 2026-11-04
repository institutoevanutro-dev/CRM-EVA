import { describe, expect, it } from "vitest";

import type { Message } from "@/lib/types/messaging";

import { LIMITE_DO_PRONTUARIO_BYTES, situacaoDoExame } from "./exames";

const AGORA = Date.parse("2026-11-04T12:00:00.000Z");
const DIA = 24 * 60 * 60 * 1000;

function msg(p: Partial<Message> = {}): Message {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "o", conversation_id: "c", channel_session_id: "s", contact_id: "k",
    external_id: null, type: "document", direction: "inbound", status: "received", ack: null,
    error_code: null, error_message: null, body: null, media_url: null,
    media_mime: "application/pdf", media_size_bytes: 1000,
    media_storage_path: "o/c/11111111-1111-4111-8111-111111111111.pdf",
    sent_via: "external_device", sent_by_user_id: null,
    sent_at: new Date(AGORA - DIA).toISOString(), delivered_at: null, read_at: null,
    metadata: {}, edited_at: null, revoked_at: null, reply_to_message_id: null,
    created_at: new Date(AGORA - DIA).toISOString(), ...p,
  };
}

describe("situacaoDoExame", () => {
  it("PDF, JPEG e PNG guardados: botão (também JPEG como documento e mime com parâmetro)", () => {
    expect(situacaoDoExame(msg(), AGORA)).toBe("botao");
    expect(situacaoDoExame(msg({ type: "image", media_mime: "image/jpeg; charset=binary" }), AGORA)).toBe("botao");
    expect(situacaoDoExame(msg({ type: "document", media_mime: "IMAGE/PNG" }), AGORA)).toBe("botao");
  });

  it("webp e heic guardados: dica de formato", () => {
    expect(situacaoDoExame(msg({ media_mime: "image/heic" }), AGORA)).toBe("formato");
    expect(situacaoDoExame(msg({ type: "image", media_mime: "image/webp" }), AGORA)).toBe("formato");
  });

  it("exatamente 10 MiB é botão; 10 MiB + 1 é grande", () => {
    expect(situacaoDoExame(msg({ media_size_bytes: LIMITE_DO_PRONTUARIO_BYTES }), AGORA)).toBe("botao");
    expect(situacaoDoExame(msg({ media_size_bytes: LIMITE_DO_PRONTUARIO_BYTES + 1 }), AGORA)).toBe("grande");
  });

  it("janela de 60 dias: 60 d − 1 min dentro, 60 d + 1 min fora", () => {
    expect(situacaoDoExame(msg({ sent_at: new Date(AGORA - 60 * DIA + 60_000).toISOString() }), AGORA)).toBe("botao");
    expect(situacaoDoExame(msg({ sent_at: new Date(AGORA - 60 * DIA - 60_000).toISOString() }), AGORA)).toBeNull();
  });

  it("worker desistiu (media_status failed, sem caminho): falhou só para formato aceito", () => {
    expect(situacaoDoExame(msg({ media_storage_path: null, metadata: { media_status: "failed" } }), AGORA)).toBe("falhou");
    expect(situacaoDoExame(msg({ media_storage_path: null, media_mime: "image/heic", metadata: { media_status: "failed" } }), AGORA)).toBeNull();
  });

  it("nada: outbound, outro tipo, apagada, pendente, sem tamanho, mime fora", () => {
    expect(situacaoDoExame(msg({ direction: "outbound" }), AGORA)).toBeNull();
    expect(situacaoDoExame(msg({ type: "audio" }), AGORA)).toBeNull();
    expect(situacaoDoExame(msg({ revoked_at: new Date(AGORA).toISOString() }), AGORA)).toBeNull();
    expect(situacaoDoExame(msg({ media_storage_path: null }), AGORA)).toBeNull();
    expect(situacaoDoExame(msg({ media_storage_path: null, metadata: { media_status: "expired" } }), AGORA)).toBeNull();
    expect(situacaoDoExame(msg({ media_size_bytes: null }), AGORA)).toBeNull();
    expect(situacaoDoExame(msg({ media_mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), AGORA)).toBeNull();
  });
});

describe("FRASE_DO_CODIGO", () => {
  it("toda frase tem espanhol, e o português não muda", async () => {
    const { FRASE_DO_CODIGO, fraseDoCodigo } = await import("./exames");
    const { DICIONARIO, traduzir } = await import("@/lib/i18n/dicionario");
    for (const [codigo, frase] of Object.entries(FRASE_DO_CODIGO)) {
      expect(DICIONARIO[frase]?.es, codigo).toBeTruthy();
      expect(traduzir(frase, "pt-BR")).toBe(frase);
    }
    expect(fraseDoCodigo("vinculo_nao_confirmado", (s) => traduzir(s, "es"))).toBe(
      "Este contacto aún no está confirmado en la historia clínica. Pida que confirmen el vínculo allí.",
    );
  });
});
