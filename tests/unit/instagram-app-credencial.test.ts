import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ig_app_id: "123", ig_app_secret_encrypted: "cifrado" }, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "segredo" }));

const { appDoInstagram, instagramPodeConectar, invalidarAppDoInstagram } = await import("@/lib/channels/instagram/app");

describe("credencial do app do Instagram", () => {
  it("lê do banco e decifra o segredo", async () => {
    invalidarAppDoInstagram();
    const app = await appDoInstagram();
    expect(app).toEqual({ appId: "123", appSecret: "segredo" });
    expect(instagramPodeConectar(app)).toBe(true);
  });
  it("sem segredo não conecta", () => {
    expect(instagramPodeConectar({ appId: "123", appSecret: null })).toBe(false);
  });
});
