import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O GET da aba Conexões diz se o botão "Conectar WhatsApp" pode aparecer e,
 * se não, QUAL dos dois valores falta (App ID / Configuration ID).
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SEGREDO_DO_BANCO = "segredo-do-banco-de-teste";
const TOKEN_DO_BANCO = "token-do-banco-que-o-tenant-nao-ve";
const SEGREDO_DO_ENV = "segredo-do-env-de-teste";
const TOKEN_DO_ENV = "token-do-env-de-teste";

let linhaDaMeta: { app_secret_encrypted: string | null; verify_token_encrypted: string | null } | null = null;
let usuario: { id: string; idioma: "pt-BR"; is_platform_admin: boolean; support?: boolean } = {
  id: "u1",
  idioma: "pt-BR",
  is_platform_admin: false,
};

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: usuario, org: { orgId: ORG, role: "admin" } }),
}));

vi.mock("@/lib/supabase/admin", () => {
  const canal = {
    id: "canal-1",
    meta_phone_number_id: "1103328999528818",
    meta_waba_id: "2434045433735175",
    meta_token_encrypted: "\\x_cifra",
    phone_number: "+5511999998888",
    display_name: "Canal oficial",
    webhook_path_token: "tok-do-canal",
    status: "WORKING",
  };
  const cadeiaDoCanal = {
    select: () => cadeiaDoCanal,
    eq: () => cadeiaDoCanal,
    is: () => cadeiaDoCanal,
    maybeSingle: async () => ({ data: canal, error: null }),
  };
  return {
    createAdminClient: () => ({
      from: (tabela: string) =>
        tabela === "platform_meta_app"
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linhaDaMeta, error: null }) }) }) }
          : cadeiaDoCanal,
    }),
  };
});

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(),
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) =>
    ({ cifra_segredo: SEGREDO_DO_BANCO, cifra_token: TOKEN_DO_BANCO })[cifrado] ?? null,
}));


beforeEach(async () => {
  linhaDaMeta = null;
  usuario = { id: "u1", idioma: "pt-BR", is_platform_admin: false };
  delete process.env.META_APP_ID;
  delete process.env.META_ES_CONFIG_ID;
  (await import("@/lib/channels/meta/app")).invalidarAppDaMeta();
});

async function cadastro(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/v1/channels/official/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/channels/official"));
  return ((await res.json()) as { data: { cadastroIncorporado: Record<string, unknown> } }).data.cadastroIncorporado;
}

describe("GET /api/v1/channels/official — cadastroIncorporado", () => {
  it("só o App ID: indisponível e falta o Configuration ID", async () => {
    process.env.META_APP_ID = "1";
    const c = await cadastro();
    expect(c).toMatchObject({ disponivel: false, appId: "1", configId: null, faltam: ["META_ES_CONFIG_ID"] });
  });

  it("os dois: disponível, nada falta", async () => {
    process.env.META_APP_ID = "1";
    process.env.META_ES_CONFIG_ID = "2";
    expect(await cadastro()).toMatchObject({ disponivel: true, configId: "2", faltam: [] });
  });

  it("o link da tela da instalação só vai a quem administra a instalação", async () => {
    expect((await cadastro()).configurarEm).toBeNull();
    usuario = { ...usuario, is_platform_admin: true };
    expect((await cadastro()).configurarEm).toBe("/admin/meta");
  });
});
