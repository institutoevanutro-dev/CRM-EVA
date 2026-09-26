import { describe, expect, it } from "vitest";
import { parseComentariosDoInstagram, parseWebhookDoInstagram } from "./webhook";

const base = (messaging: unknown[]) => ({ object: "instagram", entry: [{ id: "17841400000000001", time: 1727170000000, messaging }] });

describe("parse do webhook do Instagram", () => {
  it("texto recebido", () => {
    const [e] = parseWebhookDoInstagram(base([{ sender: { id: "IGSID9" }, recipient: { id: "17841400000000001" }, timestamp: 1727170000000, message: { mid: "m1", text: "Oi" } }]));
    expect(e!).toMatchObject({ igAccountId: "17841400000000001", remetente: "IGSID9", externalId: "m1", eco: false, texto: "Oi", anexos: [] });
    expect(e!.enviadaEm.getTime()).toBe(1727170000000);
  });

  it("imagem sem texto", () => {
    const [e] = parseWebhookDoInstagram(base([{ sender: { id: "IGSID9" }, recipient: { id: "17841400000000001" }, timestamp: 1, message: { mid: "m2", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] } }]));
    expect(e!.texto).toBeNull();
    expect(e!.anexos).toEqual([{ tipo: "image", url: "https://cdn/x.jpg" }]);
  });

  it("eco da própria conta", () => {
    const [e] = parseWebhookDoInstagram(base([{ sender: { id: "17841400000000001" }, recipient: { id: "IGSID9" }, timestamp: 1, message: { mid: "m3", text: "Olá!", is_echo: true } }]));
    expect(e!.eco).toBe(true);
  });

  it("reação, mensagem apagada, leitura e objeto de outro produto são ignorados", () => {
    expect(parseWebhookDoInstagram(base([{ sender: { id: "a" }, recipient: { id: "b" }, timestamp: 1, reaction: { mid: "m1", action: "react" } }]))).toEqual([]);
    expect(parseWebhookDoInstagram(base([{ sender: { id: "a" }, recipient: { id: "b" }, timestamp: 1, message: { mid: "m4", is_deleted: true } }]))).toEqual([]);
    expect(parseWebhookDoInstagram(base([{ sender: { id: "a" }, recipient: { id: "b" }, timestamp: 1, read: { mid: "m1" } }]))).toEqual([]);
    expect(parseWebhookDoInstagram({ object: "page", entry: [] })).toEqual([]);
    expect(parseWebhookDoInstagram("lixo")).toEqual([]);
  });

  it("item malformado no meio é pulado, preservando válidos antes e depois", () => {
    const result = parseWebhookDoInstagram(base([
      { sender: { id: "IGSID9" }, recipient: { id: "17841400000000001" }, timestamp: 1, message: { mid: "a", text: "Válido 1" } },
      { sender: {}, recipient: { id: "x" } }, // malformed: missing timestamp, sender.id, message
      { sender: { id: "IGSID9" }, recipient: { id: "17841400000000001" }, timestamp: 2, message: { mid: "c", text: "Válido 2" } },
    ]));
    expect(result).toHaveLength(2);
    expect(result[0]!.externalId).toBe("a");
    expect(result[1]!.externalId).toBe("c");
  });

  it("parseWebhookDoInstagram(null) e messaging inválido não lançam", () => {
    expect(parseWebhookDoInstagram(null)).toEqual([]);
    expect(parseWebhookDoInstagram({ object: "instagram", entry: [{ id: "1", messaging: "lixo" }] })).toEqual([]);
  });
});

const payloadDeComentario = {
  object: "instagram",
  entry: [{
    id: "IG-CONTA-1",
    time: 1790000000,
    changes: [{
      field: "comments",
      value: {
        id: "COMENTARIO-1",
        text: "CARDAPIO",
        media: { id: "MEDIA-9", media_product_type: "REELS" },
        from: { id: "IGSID-7", username: "fulana" },
        timestamp: "2026-09-26T12:00:00+0000",
      },
    }],
  }],
};

describe("parse de comentários do Instagram", () => {
  it("lê o comentário do campo changes", () => {
    const [c] = parseComentariosDoInstagram(payloadDeComentario);
    expect(c).toMatchObject({
      igAccountId: "IG-CONTA-1", externalId: "COMENTARIO-1", mediaId: "MEDIA-9",
      texto: "CARDAPIO", autorIgsid: "IGSID-7", autorHandle: "fulana", eco: false,
    });
  });

  it("comentário do próprio perfil vem marcado como eco", () => {
    const meu = structuredClone(payloadDeComentario);
    meu.entry[0]!.changes[0]!.value.from.id = "IG-CONTA-1";
    expect(parseComentariosDoInstagram(meu)[0]!.eco).toBe(true);
  });

  it("campo que não é comments é ignorado", () => {
    const outro = structuredClone(payloadDeComentario);
    outro.entry[0]!.changes[0]!.field = "live_comments";
    expect(parseComentariosDoInstagram(outro)).toEqual([]);
  });

  it("payload de MENSAGEM não vira comentário, e continua virando mensagem", () => {
    const msg = {
      object: "instagram",
      entry: [{ id: "IG-CONTA-1", messaging: [{
        sender: { id: "IGSID-7" }, recipient: { id: "IG-CONTA-1" }, timestamp: 1790000000000,
        message: { mid: "MID-1", text: "oi" },
      }] }],
    };
    expect(parseComentariosDoInstagram(msg)).toEqual([]);
    expect(parseWebhookDoInstagram(msg)).toHaveLength(1);
  });

  it("comentário só com emoji é lido, não descartado", () => {
    const emoji = structuredClone(payloadDeComentario);
    emoji.entry[0]!.changes[0]!.value.text = "🔥";
    expect(parseComentariosDoInstagram(emoji)[0]!.texto).toBe("🔥");
  });
});
