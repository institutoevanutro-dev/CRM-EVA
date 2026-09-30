/**
 * C2 (auditoria 2026-09-29) — com só a senha (sessão `aal1`) dava para gerar
 * códigos de recuperação e, com eles, apagar o TOTP. Gerar códigos e mudar a
 * exigência de MFA da empresa pedem o fator provado nesta sessão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { regenerateRecoveryCodes } from "@/app/actions/settings/regenerateRecoveryCodes";
import { definirExigenciaDeMfa } from "@/app/actions/auth/politicaDeMfa";
import { isMfaEnrolled, sessionAal } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1", is_platform_admin: false, organizations: [] })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org1", name: "Org", role: "admin" })),
  sessionAal: vi.fn(),
  isMfaEnrolled: vi.fn(async () => true),
  mfaEmDivida: vi.fn(async () => (await isMfaEnrolled()) && (await sessionAal()) !== "aal2"),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      mfa: { listFactors: async () => ({ data: { totp: [{ status: "verified" }] } }) },
    },
  })),
}));

function adminFalso() {
  const q = {
    select: () => q,
    eq: () => q,
    delete: () => q,
    insert: async () => ({ error: null }),
    update: () => q,
    maybeSingle: async () => ({ data: { settings: {} }, error: null }),
    then: (r: (v: { error: null }) => unknown) => r({ error: null }),
  };
  return { from: vi.fn(() => q) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(adminFalso() as any);
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

describe("regenerateRecoveryCodes", () => {
  it("recusa sessão aal1 e não toca nos códigos", async () => {
    vi.mocked(sessionAal).mockResolvedValue("aal1");
    const r = await regenerateRecoveryCodes();
    expect(r).toEqual({ ok: false, error: "mfa_required" });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("gera com sessão aal2", async () => {
    vi.mocked(sessionAal).mockResolvedValue("aal2");
    const r = await regenerateRecoveryCodes();
    expect(r.ok).toBe(true);
  });
});

describe("definirExigenciaDeMfa", () => {
  it("recusa admin com fator e sessão aal1", async () => {
    vi.mocked(sessionAal).mockResolvedValue("aal1");
    const r = await definirExigenciaDeMfa(false);
    expect(r.ok).toBe(false);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("aceita admin sem fator (instalação nova ligando a regra)", async () => {
    vi.mocked(isMfaEnrolled).mockResolvedValue(false);
    vi.mocked(sessionAal).mockResolvedValue("aal1");
    const r = await definirExigenciaDeMfa(true);
    expect(r).toEqual({ ok: true });
  });
});
