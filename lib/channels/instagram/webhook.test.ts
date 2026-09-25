import { describe, expect, it } from "vitest";
import { parseWebhookDoInstagram } from "./webhook";

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
