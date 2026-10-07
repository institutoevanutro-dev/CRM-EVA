import { describe, expect, it } from "vitest";

import { hojeNaClinica } from "./termo";
import { criarMidiaSchema, editarMidiaSchema, variantesDoItem, variantesSchema } from "./esquemas";

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
  it("assinatura no futuro é recusada; hoje vale", () => {
    const termo = (signed_at: string) => ({ consent: { subject: "Maria", scope: "x", signed_at, expires_at: null } });
    expect(editarMidiaSchema.safeParse(termo("2999-01-01")).success).toBe(false);
    expect(editarMidiaSchema.safeParse(termo(hojeNaClinica())).success).toBe(true);
  });
  it("consent e revogar juntos são recusados", () => {
    const consent = { subject: "Maria", scope: "x", signed_at: "2026-10-01", expires_at: null };
    expect(editarMidiaSchema.safeParse({ consent, revogar: true }).success).toBe(false);
  });
  it("variantes: no máximo 2 e sem chave repetida", () => {
    const v = (key: "A" | "B") => ({ key, storage_path: "o/i/A-1.png", mime: "image/png", size_bytes: 1 });
    expect(variantesSchema.safeParse([v("A"), v("B")]).success).toBe(true);
    expect(variantesSchema.safeParse([v("A"), v("A")]).success).toBe(false);
  });
});

describe("variantesDoItem", () => {
  const v = (storage_path: string) => ({ key: "A", storage_path, mime: "image/png", size_bytes: 1 });
  it("mantém o caminho da própria org e item", () => {
    expect(variantesDoItem([v("o1/i1/A-x.png")], "o1", "i1")).toHaveLength(1);
  });
  it("descarta caminho de outra org, de outro item e com ..", () => {
    expect(variantesDoItem([v("o2/i1/A-x.png")], "o1", "i1")).toEqual([]);
    expect(variantesDoItem([v("o1/i2/A-x.png")], "o1", "i1")).toEqual([]);
    expect(variantesDoItem([v("o1/i1/../../o2/i1/A.png")], "o1", "i1")).toEqual([]);
    expect(variantesDoItem([v("o1/i1/..")], "o1", "i1")).toEqual([]);
  });
  it("lixo vira []", () => {
    expect(variantesDoItem("x", "o1", "i1")).toEqual([]);
    expect(variantesDoItem(null, "o1", "i1")).toEqual([]);
  });
});
