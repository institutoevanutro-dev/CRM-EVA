import { describe, expect, it } from "vitest";

import { criarMidiaSchema, editarMidiaSchema, variantesSchema } from "./esquemas";

describe("esquemas da biblioteca", () => {
  it("cria com título; recusa título vazio e campo desconhecido", () => {
    expect(criarMidiaSchema.safeParse({ title: "Vídeo da unidade" }).success).toBe(true);
    expect(criarMidiaSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(criarMidiaSchema.safeParse({ title: "x", organization_id: "y" }).success).toBe(false);
  });
  it("editar exige ao menos um campo", () => {
    expect(editarMidiaSchema.safeParse({}).success).toBe(false);
    expect(editarMidiaSchema.safeParse({ revogar: true }).success).toBe(true);
  });
  it("termo exige titular e data de assinatura em YYYY-MM-DD", () => {
    expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "WhatsApp comercial", signed_at: "2026-10-01", expires_at: null } }).success).toBe(true);
    expect(editarMidiaSchema.safeParse({ consent: { subject: "", scope: "x", signed_at: "2026-10-01", expires_at: null } }).success).toBe(false);
    expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "x", signed_at: "01/10/2026", expires_at: null } }).success).toBe(false);
  });
  it("data impossível (2026-13-45, 2026-02-30) é recusada", () => {
    for (const d of ["2026-13-45", "2026-02-30"]) {
      expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "x", signed_at: d, expires_at: null } }).success).toBe(false);
    }
  });
  it("validade antes da assinatura é recusada", () => {
    expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "x", signed_at: "2026-10-01", expires_at: "2026-09-01" } }).success).toBe(false);
  });
  it("variantes: no máximo 2 e sem chave repetida", () => {
    const v = (key: "A" | "B") => ({ key, storage_path: "o/i/A-1.png", mime: "image/png", size_bytes: 1 });
    expect(variantesSchema.safeParse([v("A"), v("B")]).success).toBe(true);
    expect(variantesSchema.safeParse([v("A"), v("A")]).success).toBe(false);
  });
});
