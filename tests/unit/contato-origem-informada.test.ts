import { describe, expect, it, vi } from "vitest";
import { origemInformadaDe } from "@/lib/contacts/origem-informada";
import { contactPatchSchema } from "@/lib/schemas/contacts";

describe("Como chegou (origem informada na ficha)", () => {
  it("lê só valores do vocabulário", () => {
    expect(origemInformadaDe({ origem_informada: "meta", ad_platform: "google_ads" })).toBe("meta");
    expect(origemInformadaDe({ origem_informada: "tiktok" })).toBeNull();
    expect(origemInformadaDe({})).toBeNull();
    expect(origemInformadaDe(null)).toBeNull();
  });
  it("o PATCH aceita as quatro origens e null, e recusa o resto", () => {
    for (const o of ["meta", "google", "indicacao", "organico", null]) expect(contactPatchSchema.safeParse({ origem_informada: o }).success).toBe(true);
    expect(contactPatchSchema.safeParse({ origem_informada: "tiktok" }).success).toBe(false);
  });
});

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

describe("PATCH grava o Como chegou por MERGE no source_metadata", () => {
  const estado = {
    id: "c0000000-0000-4000-8000-0000000000c1",
    organization_id: "c0000000-0000-4000-8000-000000000001",
    is_anonymized: false,
    is_blocked: false,
    tags: [],
    consent: {},
    source_metadata: { ad_platform: "meta_ads", ctwa_clid: "x" },
  };
  async function patch(input: Record<string, unknown>) {
    let gravado: Record<string, unknown> | null = null;
    const cliente = {
      from: () => ({
        select: () => {
          const c = { eq: () => c, maybeSingle: async () => ({ data: estado, error: null }) };
          return c;
        },
        update: (p: Record<string, unknown>) => {
          gravado = p;
          const c = { eq: () => c, select: () => c, maybeSingle: async () => ({ data: { ...estado, ...p }, error: null }) };
          return c;
        },
      }),
      rpc: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
    };
    const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await patchContactHandler(cliente as never, { organization_id: estado.organization_id, actor: { type: "user", id: "u" }, requestId: "r" }, estado.id, input as never);
    return gravado as Record<string, unknown> | null;
  }
  it("acrescenta a chave sem apagar a marca do anúncio", async () => {
    expect((await patch({ origem_informada: "google" }))?.source_metadata).toEqual({ ad_platform: "meta_ads", ctwa_clid: "x", origem_informada: "google" });
  });
  it("null tira só a chave", async () => {
    expect((await patch({ origem_informada: null }))?.source_metadata).toEqual({ ad_platform: "meta_ads", ctwa_clid: "x" });
  });
});
