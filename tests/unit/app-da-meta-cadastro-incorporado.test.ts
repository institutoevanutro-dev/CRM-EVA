import { describe, expect, it, vi } from "vitest";

import { appDaMetaDoAmbiente, VARIAVEIS_DO_CADASTRO_INCORPORADO } from "@/lib/channels/meta/app";

describe("app da Meta — Cadastro Incorporado", () => {
  it("lê META_APP_ID e META_ES_CONFIG_ID do ambiente, vazio é ausente", () => {
    expect(appDaMetaDoAmbiente({ META_APP_ID: " 1054112660758768 ", META_ES_CONFIG_ID: "" })).toMatchObject({
      appId: "1054112660758768",
      esConfigId: null,
    });
  });
  it("as variáveis que a tela pode nomear", () => {
    expect(VARIAVEIS_DO_CADASTRO_INCORPORADO).toEqual(["META_APP_ID", "META_ES_CONFIG_ID"]);
  });
});

describe("updateMetaApp — App ID e Configuration ID", () => {
  it("grava app_id e es_config_id como texto puro e audita só os nomes dos campos", async () => {
    vi.resetModules();
    const upserts: Record<string, unknown>[] = [];
    const auditorias: { metadata?: Record<string, unknown> }[] = [];
    vi.doMock("@/lib/auth/requirePlatformAdmin", () => ({
      requirePlatformAdmin: async () => ({ user: { id: "11111111-1111-4111-8111-111111111111" } }),
    }));
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { app_secret_encrypted: "\\x1", verify_token_encrypted: "\\x2", ig_app_secret_encrypted: null },
                error: null,
              }),
            }),
          }),
          upsert: async (v: Record<string, unknown>) => {
            upserts.push(v);
            return { error: null };
          },
        }),
      }),
    }));
    vi.doMock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "cifra" }));
    vi.doMock("@/lib/audit", () => ({ audit: async (e: { metadata?: Record<string, unknown> }) => void auditorias.push(e) }));

    const { updateMetaApp } = await import("@/app/actions/settings/updateMetaApp");
    const r = await updateMetaApp({ app_id: "1054112660758768", es_config_id: "9876" });

    expect(r).toEqual({ ok: true });
    expect(upserts[0]).toMatchObject({ id: 1, app_id: "1054112660758768", es_config_id: "9876" });
    expect(auditorias[0]?.metadata).toMatchObject({ campos: ["app_id", "es_config_id"] });
  });
});
