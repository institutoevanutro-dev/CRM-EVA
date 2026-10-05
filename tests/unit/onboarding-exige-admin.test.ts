/**
 * C1 (auditoria 2026-09-29) — o onboarding configura a organização inteira
 * (agente, memória, funil, convites com papel), então só o administrador passa.
 *
 * O papel vem do BANCO (`fn_user_role_in_org`), não do snapshot do cookie: um
 * viewer com `active_org` válido chamava a server action e convidava outra
 * conta sua como admin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireOnboardingCtx } from "@/app/actions/onboarding/_shared";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";

function sessao(opts: { cookieRole: string; dbRole: string | null; platformAdmin?: boolean; scope?: string }) {
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: opts.platformAdmin ?? false,
    platform_admin_scope: opts.platformAdmin ? (opts.scope ?? "full") : null,
    idioma: "pt-BR",
    organizations: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(resolveActiveOrg).mockResolvedValue({
    orgId: ORG,
    name: "Org",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: opts.cookieRole as any,
  });
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: opts.dbRole, error: null } : { data: null, error: null },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => vi.clearAllMocks());

describe("requireOnboardingCtx — só admin configura a organização", () => {
  it.each(["viewer", "provider", "agent", "manager"])("nega %s", async (role) => {
    sessao({ cookieRole: role, dbRole: role });
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("nega quando o cookie diz admin mas o banco diz viewer (papel rebaixado)", async () => {
    sessao({ cookieRole: "admin", dbRole: "viewer" });
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("nega membership revogada (banco devolve null)", async () => {
    sessao({ cookieRole: "admin", dbRole: null });
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("aceita o admin — o criador da organização segue o wizard", async () => {
    sessao({ cookieRole: "admin", dbRole: "admin" });
    await expect(requireOnboardingCtx()).resolves.toMatchObject({ orgId: ORG, role: "admin" });
  });

  it("aceita o admin de plataforma (o dono criado pelo install.sh)", async () => {
    sessao({ cookieRole: "agent", dbRole: "agent", platformAdmin: true });
    await expect(requireOnboardingCtx()).resolves.toMatchObject({ orgId: ORG });
  });

  // Só no fork (este arquivo não é "use server", então a cerca do AST não o vê):
  // o `support_readonly` tem a mesma linha em `platform_admins`, e com a flag
  // sozinha ele reconfigurava a organização em que é membro comum.
  it("nega o admin de plataforma SÓ LEITURA que é agente na organização", async () => {
    sessao({ cookieRole: "agent", dbRole: "agent", platformAdmin: true, scope: "support_readonly" });
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("nega admin com fator TOTP cadastrado e sessão aal1", async () => {
    sessao({ cookieRole: "admin", dbRole: "admin" });
    vi.mocked(mfaEmDivida).mockResolvedValueOnce(true);
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });
});
