import { describe, expect, it } from "vitest";

import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";

describe("validateOutboundMedia", () => {
  it("classifica mimes suportados no kind certo", () => {
    expect(validateOutboundMedia("image/jpeg", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("image/webp", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("video/mp4", 1000)).toEqual({ ok: true, kind: "video" });
    expect(validateOutboundMedia("audio/ogg; codecs=opus", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("audio/webm", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("application/pdf", 1000)).toEqual({ ok: true, kind: "document" });
    expect(validateOutboundMedia("text/csv", 1000)).toEqual({ ok: true, kind: "document" });
  });
  it("rejeita mime não suportado", () => {
    const r = validateOutboundMedia("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("rejeita acima de 50MB", () => {
    const r = validateOutboundMedia("image/jpeg", 51 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("payload_too_large");
  });
  it("rejeita arquivo vazio", () => {
    const r = validateOutboundMedia("image/jpeg", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("validation_failed");
  });
});

// C3 (auditoria 2026-09-29): o `file.type` é do cliente e mente quando quer.
describe("validateOutboundMedia — bytes reais", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
  const HTML = new TextEncoder().encode("<!doctype html><html><script>alert(1)</script></html>");

  it("recusa image/svg+xml mesmo com bytes de SVG legítimo", () => {
    const r = validateOutboundMedia("image/svg+xml", SVG.length, SVG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("recusa SVG rotulado como image/png", () => {
    expect(validateOutboundMedia("image/png", SVG.length, SVG).ok).toBe(false);
  });
  it("recusa HTML rotulado como application/pdf", () => {
    expect(validateOutboundMedia("application/pdf", HTML.length, HTML).ok).toBe(false);
  });
  it("aceita PNG de verdade", () => {
    expect(validateOutboundMedia("image/png", PNG.length, PNG)).toEqual({ ok: true, kind: "image" });
  });
});
