// @vitest-environment node
/**
 * COM A CONTA LIGADA, O CRM NÃO ESCREVE A MARCA DA CLÍNICA (Plano 6, Tarefa 4).
 *
 * Com a marca da Conta EM VIGOR (`CONTA_URL` + marca guardada), nome, cor e logo
 * vêm da Conta Eva Link. As portas de escrita
 * do CRM passam a aceitar só o que continua local:
 *  - `updateBranding` (instalação): só `show_powered_by`; nome/cor/URL → `marca_na_conta`.
 *  - `updateMarcaDaOrganizacao`: só `menu_hex`, preservando nome e cor gravados
 *    (a função SQL substitui o objeto `branding` inteiro).
 *  - `/api/v1/marca/logo` POST e DELETE: 409 `marca_na_conta` nos dois escopos.
 * Sem `CONTA_URL`, ou com ela e nada guardado ainda (primeiro boot, Conta fora
 * do ar), tudo segue como antes — o controle de cada caso está aqui.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModBranding from "@/app/actions/settings/updateBranding";
import type * as ModOrg from "@/app/actions/settings/updateMarcaDaOrganizacao";
import type * as ModRota from "@/app/api/v1/marca/logo/route";

const h = vi.hoisted(() => ({
  upsert: vi.fn(async (_v: Record<string, unknown>, _o?: unknown) => ({ error: null })),
  rpc: vi.fn(async (_n: string, _a: Record<string, unknown>) => ({ data: 1, error: null })),
  settings: null as Record<string, unknown> | null,
  guardada: null as Record<string, unknown> | null,
  erroNaConta: false,
  audit: vi.fn(async (_e: Record<string, unknown>) => undefined),
  bucket: vi.fn(() => {
    throw new Error("chegou no bucket");
  }),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  supportWriteError: () => null,
}));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  EscritaDePlatformAdminNegada: class extends Error {},
  requirePlatformAdminEscrita: async () => ({ user: { id: "pa-1" } }),
}));
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({ ok: true, ctx: { user: { id: "pa-1" } } }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", is_platform_admin: false, support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: h.rpc,
    storage: { from: h.bucket },
    from: () => {
      const c: Record<string, unknown> = { upsert: h.upsert };
      let colunas = "";
      c.select = (cols: string) => ((colunas = cols), c);
      c.eq = () => c;
      c.abortSignal = () => c;
      c.maybeSingle = async () =>
        colunas.startsWith("conta_")
          ? h.erroNaConta
            ? { data: null, error: { code: "08006", message: "conexão caiu" } }
            : { data: h.guardada, error: null }
          : { data: { settings: h.settings }, error: null };
      return c;
    },
  }),
}));

const CONTA = "https://conta.exemplo.test";
const GUARDADA = { conta_nome: "Clínica da Conta", conta_accent_hex: "#27463b", conta_logo_path: null };

/** `conta`: liga `CONTA_URL` e guarda a marca dela; `"sem-guardada"`: só liga. */
async function carregar<T>(caminho: string, conta: boolean | "sem-guardada"): Promise<T> {
  vi.resetModules();
  vi.stubEnv("CONTA_URL", conta ? CONTA : "");
  h.guardada = conta === true ? GUARDADA : null;
  return (await import(caminho)) as T;
}

beforeEach(() => {
  h.upsert.mockClear();
  h.rpc.mockClear();
  h.audit.mockClear();
  h.bucket.mockClear();
  h.settings = null;
  h.erroNaConta = false;
});
afterEach(() => vi.unstubAllEnvs());

type Branding = typeof ModBranding;
type Org = typeof ModOrg;
type Rota = typeof ModRota;

const instalacao = (extra: Record<string, unknown> = {}) => ({
  app_name: null,
  logo_url: null,
  accent_hex: null,
  show_powered_by: false,
  ...extra,
});

describe("updateBranding com a Conta", () => {
  it("grava SÓ show_powered_by — nome, cor e URL locais ficam como estão", async () => {
    const { updateBranding } = await carregar<Branding>("@/app/actions/settings/updateBranding", true);
    expect(await updateBranding(instalacao())).toEqual({ ok: true });
    const [valores] = h.upsert.mock.calls[0]!;
    expect(valores).toEqual({ id: 1, show_powered_by: false, updated_by: "pa-1" });
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      action: "platform_branding.updated",
      metadata: { fields_changed: ["show_powered_by"], marca_na_conta: true },
    });
  });

  it.each([{ app_name: "Outra" }, { accent_hex: "#123456" }, { logo_url: "https://x.test/l.png" }])(
    "campo de marca enviado (%o) é recusado com marca_na_conta, sem gravar",
    async (campo) => {
      const { updateBranding } = await carregar<Branding>("@/app/actions/settings/updateBranding", true);
      expect(await updateBranding(instalacao(campo))).toEqual({ ok: false, error: "marca_na_conta" });
      expect(h.upsert).not.toHaveBeenCalled();
      expect(h.audit).not.toHaveBeenCalled();
    },
  );

  it("CONTA_URL ligada mas nada guardado da Conta: a marca local continua editável", async () => {
    const { updateBranding } = await carregar<Branding>("@/app/actions/settings/updateBranding", "sem-guardada");
    expect(await updateBranding(instalacao({ app_name: "Outra" }))).toEqual({ ok: true });
    expect(h.upsert.mock.calls[0]![0]).toMatchObject({ app_name: "Outra" });
  });

  it("guardado da Conta ilegível com CONTA_URL: recusa e não grava", async () => {
    const { updateBranding } = await carregar<Branding>("@/app/actions/settings/updateBranding", true);
    h.erroNaConta = true;
    expect(await updateBranding(instalacao())).toEqual({ ok: false, error: "db_error" });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("sem CONTA_URL, grava a marca inteira como antes", async () => {
    const { updateBranding } = await carregar<Branding>("@/app/actions/settings/updateBranding", false);
    expect(await updateBranding(instalacao({ app_name: "Outra", accent_hex: "#123456" }))).toEqual({ ok: true });
    expect(h.upsert.mock.calls[0]![0]).toMatchObject({ app_name: "Outra", accent_hex: "#123456", seeded_from_env: false });
  });
});

describe("updateMarcaDaOrganizacao com a Conta", () => {
  it("o pedido da tela com a Conta (sem nome nem cor) grava só menu_hex e preserva o resto", async () => {
    h.settings = { branding: { app_name: "Org Local", accent_hex: "#1f4e5f", logo_path: "org-1/l.png" } };
    const { updateMarcaDaOrganizacao } = await carregar<Org>("@/app/actions/settings/updateMarcaDaOrganizacao", true);
    expect(await updateMarcaDaOrganizacao({ menu_hex: "#ABC" })).toEqual({ ok: true });
    expect(h.rpc.mock.calls[0]![1].p_marca).toMatchObject({
      app_name: "Org Local",
      accent_hex: "#1f4e5f",
      menu_hex: "#aabbcc",
    });
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ metadata: { fields_changed: ["menu_hex"], marca_na_conta: true } });
  });

  it("menu vazio sem nada gravado continua sendo limpar", async () => {
    const { updateMarcaDaOrganizacao } = await carregar<Org>("@/app/actions/settings/updateMarcaDaOrganizacao", true);
    await updateMarcaDaOrganizacao({ menu_hex: null });
    expect(h.rpc.mock.calls[0]![1].p_marca).toBeNull();
  });

  it.each([{ app_name: "Outra" }, { accent_hex: "#123456" }])(
    "nome ou cor enviados (%o) são recusados com marca_na_conta",
    async (campo) => {
      const { updateMarcaDaOrganizacao } = await carregar<Org>("@/app/actions/settings/updateMarcaDaOrganizacao", true);
      const r = await updateMarcaDaOrganizacao({ app_name: null, accent_hex: null, menu_hex: null, ...campo });
      expect(r).toEqual({ ok: false, error: "marca_na_conta" });
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );

  it("guardado da Conta ilegível com CONTA_URL: recusa (db_error) e não grava nada", async () => {
    h.settings = { branding: { app_name: "Org Local", accent_hex: "#1f4e5f" } };
    const { updateMarcaDaOrganizacao } = await carregar<Org>("@/app/actions/settings/updateMarcaDaOrganizacao", true);
    h.erroNaConta = true;
    const r = await updateMarcaDaOrganizacao({ app_name: null, accent_hex: null, menu_hex: "#ABC" });
    expect(r).toMatchObject({ ok: false, error: "db_error" });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("aba velha da tela com a Conta, depois de a Conta voltar ao padrão: nome e cor preservados", async () => {
    h.settings = { branding: { app_name: "Org Local", accent_hex: "#1f4e5f" } };
    // Conta ligada, mas nada guardado agora: a marca local voltou a valer.
    const { updateMarcaDaOrganizacao } = await carregar<Org>(
      "@/app/actions/settings/updateMarcaDaOrganizacao",
      "sem-guardada",
    );
    expect(await updateMarcaDaOrganizacao({ menu_hex: "#334455" })).toEqual({ ok: true });
    expect(h.rpc.mock.calls[0]![1].p_marca).toMatchObject({
      app_name: "Org Local",
      accent_hex: "#1f4e5f",
      menu_hex: "#334455",
    });
  });

  it("sem CONTA_URL, null explícito continua apagando nome e cor (a tela normal)", async () => {
    h.settings = { branding: { app_name: "Org Local", accent_hex: "#1f4e5f" } };
    const { updateMarcaDaOrganizacao } = await carregar<Org>("@/app/actions/settings/updateMarcaDaOrganizacao", false);
    await updateMarcaDaOrganizacao({ app_name: null, accent_hex: null, menu_hex: "#334455" });
    expect(h.rpc.mock.calls[0]![1].p_marca).toMatchObject({ app_name: null, accent_hex: null, menu_hex: "#334455" });
  });

  it("sem CONTA_URL, nome e cor enviados são gravados como antes", async () => {
    const { updateMarcaDaOrganizacao } = await carregar<Org>("@/app/actions/settings/updateMarcaDaOrganizacao", false);
    await updateMarcaDaOrganizacao({ app_name: "Outra", accent_hex: null, menu_hex: null });
    expect(h.rpc.mock.calls[0]![1].p_marca).toMatchObject({ app_name: "Outra" });
  });
});

describe("/api/v1/marca/logo com a Conta", () => {
  const post = (escopo: string) => {
    const form = new FormData();
    form.set("escopo", escopo);
    form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], "l.png", { type: "image/png" }));
    return new NextRequest("http://localhost/api/v1/marca/logo", { method: "POST", body: form });
  };
  const del = (escopo: string) =>
    new NextRequest(`http://localhost/api/v1/marca/logo?escopo=${escopo}`, { method: "DELETE" });

  it.each(["instalacao", "organizacao"])("POST e DELETE no escopo %s respondem 409 marca_na_conta", async (escopo) => {
    const { POST, DELETE } = await carregar<Rota>("@/app/api/v1/marca/logo/route", true);
    for (const res of [await POST(post(escopo)), await DELETE(del(escopo))]) {
      expect(res.status).toBe(409);
      const corpo = (await res.json()) as { error: { code: string; message: string } };
      expect(corpo.error.code).toBe("marca_na_conta");
      expect(corpo.error.message).toMatch(/Conta Eva Link/);
    }
    expect(h.bucket).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("CONTA_URL ligada mas nada guardado: o POST segue para o bucket", async () => {
    const { POST } = await carregar<Rota>("@/app/api/v1/marca/logo/route", "sem-guardada");
    await POST(post("organizacao")).catch(() => undefined);
    expect(h.bucket).toHaveBeenCalled();
  });

  it("guardado da Conta ilegível com CONTA_URL: 503 sem tocar no bucket", async () => {
    const { POST } = await carregar<Rota>("@/app/api/v1/marca/logo/route", true);
    h.erroNaConta = true;
    const res = await POST(post("organizacao"));
    expect(res.status).toBe(503);
    expect(h.bucket).not.toHaveBeenCalled();
  });

  it("sem CONTA_URL, o POST segue para o bucket (controle)", async () => {
    const { POST } = await carregar<Rota>("@/app/api/v1/marca/logo/route", false);
    await POST(post("instalacao")).catch(() => undefined);
    expect(h.bucket).toHaveBeenCalled();
  });
});
