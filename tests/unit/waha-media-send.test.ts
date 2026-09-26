import { describe, expect, it } from "vitest";

import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { wahaSendPlanFor } from "@/lib/waha/media-send";

const media = { url: "https://signed.example/x?token=t", mime: "image/jpeg", filename: "x.jpg", caption: "oi" };

describe("wahaSendPlanFor", () => {
  it("image → sendImage com caption", () => {
    const plan = wahaSendPlanFor("image", media);
    expect(plan.endpoint).toBe("sendImage");
    expect(plan.payload.caption).toBe("oi");
    expect((plan.payload.file as { url: string }).url).toBe(media.url);
  });
  it("video → sendVideo com caption e convert", () => {
    const plan = wahaSendPlanFor("video", { ...media, mime: "video/mp4" });
    expect(plan.endpoint).toBe("sendVideo");
    expect(plan.payload.convert).toBe(true);
  });
  it("audio → sendVoice com convert (WhatsApp exige OGG/OPUS)", () => {
    const plan = wahaSendPlanFor("audio", { ...media, mime: "audio/webm;codecs=opus" });
    expect(plan.endpoint).toBe("sendVoice");
    expect(plan.payload.convert).toBe(true);
    expect(plan.payload.caption).toBeUndefined(); // voz não tem caption no WhatsApp
  });
  it("document (e desconhecidos) → sendFile com filename", () => {
    const plan = wahaSendPlanFor("document", { ...media, mime: "application/pdf", filename: "doc.pdf" });
    expect(plan.endpoint).toBe("sendFile");
    expect((plan.payload.file as { filename: string }).filename).toBe("doc.pdf");
  });
});

describe("isMediaPathOwnedBy", () => {
  const orgId = "org-1";
  const conversationId = "conv-1";

  it("path da própria org/conversa → true", () => {
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(true);
  });
  it("org diferente → false", () => {
    expect(isMediaPathOwnedBy(`org-2/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("conversa diferente → false", () => {
    expect(isMediaPathOwnedBy(`${orgId}/conv-2/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("confusão de prefixo (org-1x/...) → false", () => {
    expect(isMediaPathOwnedBy(`${orgId}x/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("o nome que o upload gera (out-<uuid>.ogg) → true", () => {
    const p = `${orgId}/${conversationId}/out-0b7c1a52-6f7e-4e0a-9d2c-1f3b5a7c9e11.ogg`;
    expect(isMediaPathOwnedBy(p, orgId, conversationId)).toBe(true);
  });

  // O storage-js põe o path cru em `/object/sign/<bucket>/<path>` e o `fetch`
  // resolve o `..`: o prefixo casava e a URL assinada era de OUTRA org.
  it.each([
    ["subida de pasta", `${orgId}/${conversationId}/../../org-2/conv-9/foo.jpg`],
    ["subida codificada", `${orgId}/${conversationId}/%2e%2e/%2e%2e/org-2/conv-9/foo.jpg`],
    ["barra invertida", `${orgId}/${conversationId}/..\\..\\org-2\\foo.jpg`],
    ["subpasta", `${orgId}/${conversationId}/sub/foo.jpg`],
    ["só o ponto-ponto", `${orgId}/${conversationId}/..`],
    ["nome vazio", `${orgId}/${conversationId}/`],
  ])("%s → false", (_nome, caminho) => {
    expect(isMediaPathOwnedBy(caminho, orgId, conversationId)).toBe(false);
  });

  it("o que o fetch faria com a subida de pasta sai mesmo da org (a razão da trava)", () => {
    const url = new URL(`http://kong/storage/v1/object/sign/whatsapp-media/${orgId}/${conversationId}/../../org-2/x.jpg`);
    expect(url.pathname).toBe("/storage/v1/object/sign/whatsapp-media/org-2/x.jpg");
  });
});
