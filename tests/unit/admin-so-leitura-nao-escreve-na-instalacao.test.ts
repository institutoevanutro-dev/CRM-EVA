// @vitest-environment node
/**
 * PLATFORM ADMIN `support_readonly` NÃO ESCREVE NA INSTALAÇÃO — pelo comportamento.
 *
 * `tests/unit/admin-escrita-exige-scope-full.test.ts` vigia a CLASSE pelo AST;
 * este arquivo executa cada porta de escrita do painel do dono que existe no
 * fork com uma sessão `support_readonly` e exige duas coisas: a recusa tem nome
 * (`forbidden_scope`) e o cliente de service role nem é pedido.
 *
 * O dublê fica UMA camada abaixo do guarda (a sessão e a linha de
 * `platform_admins`), para `requirePlatformAdminEscrita` rodar de verdade. Com
 * o guarda dublado, trocar uma porta de volta para o helper de leitura passaria
 * verde.
 *
 * Visto falhar antes do conserto: as dez portas chegavam ao service role (a
 * atualização do servidor e as quatro telas do painel não olhavam o scope; o
 * ícone e o logo olhavam só `is_platform_admin`).
 *
 * Origem: melgarafael/DeskcommCRM 4b1433523 e 0fee473d0 (rotas e server
 * actions). O ícone da aba (`/api/v1/marca/icone`) só existe no fork.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scope: "support_readonly",
  papelNaOrg: "viewer",
  mfa: false,
  serviceRole: vi.fn(() => {
    throw new Error("chegou no service role");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  supportWriteError: () => null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "pa-1" } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" }, error: null }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({
        data: { user_id: "pa-1", scope: h.scope, mfa_required: false, revoked_at: null },
        error: null,
      });
      return c;
    },
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "pa-1", is_platform_admin: true, platform_admin_scope: h.scope, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", name: "Org", role: h.papelNaOrg }),
  mfaEmDivida: async () => h.mfa,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.serviceRole }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const pedido = (url: string, method: string, form?: FormData) =>
  new NextRequest(`http://localhost${url}`, { method, ...(form ? { body: form } : {}) });
const comEscopo = (escopo: string) => {
  const form = new FormData();
  form.set("escopo", escopo);
  form.set("file", new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
  return form;
};

/** Cada porta devolve `{ status, code }` — rota ou server action, a mesma régua. */
async function daRota(resposta: Response): Promise<{ status: number; code: string | undefined }> {
  const corpo = (await resposta.json()) as { error?: { code?: string } };
  return { status: resposta.status, code: corpo.error?.code };
}
async function daAcao(r: { ok: boolean; error?: string }): Promise<{ status: number; code: string | undefined }> {
  return { status: r.ok ? 200 : 403, code: r.error };
}

const PORTAS: ReadonlyArray<readonly [string, () => Promise<{ status: number; code: string | undefined }>]> = [
  [
    "POST /system/update (disparar a atualização do servidor)",
    async () => daRota(await (await import("@/app/api/v1/system/update/route")).POST(pedido("/api/v1/system/update", "POST"))),
  ],
  [
    "POST /marca/icone",
    async () => daRota(await (await import("@/app/api/v1/marca/icone/route")).POST(pedido("/api/v1/marca/icone", "POST", comEscopo("instalacao")))),
  ],
  [
    "DELETE /marca/icone",
    async () => daRota(await (await import("@/app/api/v1/marca/icone/route")).DELETE(pedido("/api/v1/marca/icone", "DELETE"))),
  ],
  [
    "POST /marca/logo?escopo=instalacao",
    async () => daRota(await (await import("@/app/api/v1/marca/logo/route")).POST(pedido("/api/v1/marca/logo", "POST", comEscopo("instalacao")))),
  ],
  [
    "DELETE /marca/logo?escopo=instalacao",
    async () => daRota(await (await import("@/app/api/v1/marca/logo/route")).DELETE(pedido("/api/v1/marca/logo?escopo=instalacao", "DELETE"))),
  ],
  [
    "updateBranding (marca da instalação)",
    async () =>
      daAcao(
        await (await import("@/app/actions/settings/updateBranding")).updateBranding({
          app_name: "Outra marca",
          logo_url: null,
          accent_hex: null,
          show_powered_by: true,
        }),
      ),
  ],
  [
    "updateSignupMode (modo de cadastro)",
    async () => daAcao(await (await import("@/app/actions/settings/updateSignupMode")).updateSignupMode({ signup_mode: "so_convite" })),
  ],
  [
    "updateGoogleOAuth (chaves do Google)",
    async () => daAcao(await (await import("@/app/actions/settings/updateGoogleOAuth")).updateGoogleOAuth({ client_id: "1234567890-teste.apps.googleusercontent.com", client_secret: "segredo-de-teste-123" })),
  ],
  [
    "updateMetaApp (chaves da Meta)",
    async () => daAcao(await (await import("@/app/actions/settings/updateMetaApp")).updateMetaApp({ app_secret: "a".repeat(32) })),
  ],
  [
    "rotacionarVerifyTokenDaMeta",
    async () => daAcao(await (await import("@/app/actions/settings/updateMetaApp")).rotacionarVerifyTokenDaMeta()),
  ],
];

/**
 * "Passou do guarda": a resposta não é nenhuma das recusas de autorização. O
 * que vem depois (arquivo que não é imagem, service role dublado) não importa.
 */
const RECUSAS_DE_AUTORIZACAO = ["forbidden_scope", "mfa_required", "forbidden", "forbidden_role", "unauthenticated"];
async function passouDoGuarda(abrir: () => Promise<{ code: string | undefined }>): Promise<boolean> {
  const r = await abrir().catch(() => ({ code: "chegou no service role" }));
  return !RECUSAS_DE_AUTORIZACAO.includes(r.code ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.scope = "support_readonly";
  h.papelNaOrg = "viewer";
  h.mfa = false;
});

describe.each(PORTAS)("%s", (_nome, abrir) => {
  it("support_readonly é recusado com forbidden_scope, antes do service role", async () => {
    await expect(abrir()).resolves.toEqual({ status: 403, code: "forbidden_scope" });
    expect(h.serviceRole).not.toHaveBeenCalled();
  });

  it("scope full com o segundo fator pendente é recusado com mfa_required", async () => {
    h.scope = "full";
    h.mfa = true;
    await expect(abrir()).resolves.toEqual({ status: 403, code: "mfa_required" });
    expect(h.serviceRole).not.toHaveBeenCalled();
  });

  it("CONTROLE: scope full em dia passa do guarda", async () => {
    h.scope = "full";
    expect(await passouDoGuarda(abrir)).toBe(true);
  });
});

describe("logo da ORGANIZAÇÃO — o atalho de papel", () => {
  const trocar = async () =>
    daRota(await (await import("@/app/api/v1/marca/logo/route")).POST(pedido("/api/v1/marca/logo", "POST", comEscopo("organizacao"))));

  it("support_readonly que é viewer na empresa não troca o logo dela", async () => {
    await expect(trocar()).resolves.toEqual({ status: 403, code: "forbidden_role" });
    expect(h.serviceRole).not.toHaveBeenCalled();
  });

  it("CONTROLE: o admin da empresa segue trocando, mesmo sendo support_readonly na plataforma", async () => {
    h.papelNaOrg = "admin";
    expect(await passouDoGuarda(trocar)).toBe(true);
  });

  it("CONTROLE: platform admin full segue pulando o papel", async () => {
    h.scope = "full";
    expect(await passouDoGuarda(trocar)).toBe(true);
  });
});
