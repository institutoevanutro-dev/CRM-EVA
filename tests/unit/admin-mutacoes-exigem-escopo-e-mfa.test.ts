import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Suspender, reativar e resolver incidente não conferiam `platformAdmin.scope`
 * nem `mfaEmDivida()`: um admin de plataforma `support_readonly`, ou uma sessão
 * aal1 de quem tem fator, mudava o estado de qualquer organização. A criação
 * de organização (`POST /admin/tenants`) já fazia as duas checagens.
 *
 * Desde o porte de melgarafael/DeskcommCRM 34a554b37 as quatro rotas passam por
 * `requirePlatformAdminEscrita`. O dublê fica UMA camada abaixo (a sessão e a
 * linha de `platform_admins`), para o guarda de verdade rodar: com o módulo do
 * guarda dublado, trocar a rota de volta para o helper de leitura passaria verde.
 */
const h = vi.hoisted(() => ({
  scope: "full",
  mfa: vi.fn(async () => false),
  admin: vi.fn(() => {
    throw new Error("chegou no banco");
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({
        data: { user_id: "u1", scope: h.scope, mfa_required: false, revoked_at: null },
        error: null,
      });
      return c;
    },
  }),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfa }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { POST as suspender } from "@/app/api/v1/admin/tenants/[id]/suspend/route";
import { POST as reativar } from "@/app/api/v1/admin/tenants/[id]/reactivate/route";
import { POST as resolver } from "@/app/api/v1/admin/incidents/[id]/resolve/route";

const ID = "33333333-3333-4333-8333-333333333333";
const pedido = () =>
  new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ reason: "motivo com mais de dez letras", resolution_note: "nota de resolução suficiente" }),
  }) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: ID }) };

const ROTAS = [
  ["suspender", suspender],
  ["reativar", reativar],
  ["resolver incidente", resolver],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.scope = "full";
  h.mfa.mockResolvedValue(false);
});

describe.each(ROTAS)("%s", (_nome, rota) => {
  it("support_readonly é barrado antes do banco", async () => {
    h.scope = "support_readonly";
    const r = await rota(pedido(), params);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("forbidden_scope");
    expect(h.admin).not.toHaveBeenCalled();
  });

  it("sessão aal1 de quem tem fator é barrada por mfa_required", async () => {
    h.mfa.mockResolvedValue(true);
    const r = await rota(pedido(), params);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(h.admin).not.toHaveBeenCalled();
  });

  it("CONTROLE POSITIVO: escopo full, sem dívida de MFA, segue até o banco", async () => {
    await rota(pedido(), params).catch(() => undefined);
    expect(h.admin).toHaveBeenCalled();
  });
});
