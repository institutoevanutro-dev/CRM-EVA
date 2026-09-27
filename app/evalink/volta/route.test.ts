// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { decidirEntrada } from "@/lib/evalink/entrada";
import { abrirSessao, temMfaVerificado } from "@/lib/evalink/sessao";

vi.mock("@/lib/evalink/config", () => ({
  COOKIE_LOGIN: "evalink_login",
  configEvalink: () => ({ appUrl: "https://crm.test", orgPadrao: "22222222-2222-4222-8222-222222222222" }),
}));
vi.mock("@/lib/evalink/oidc", () => ({
  conferirVolta: vi.fn(async () => ({ sub: "s", email: "p@eva.test", papel: "agent" })),
}));
vi.mock("@/lib/evalink/entrada", () => ({ decidirEntrada: vi.fn() }));
vi.mock("@/lib/evalink/sessao", () => ({
  abrirSessao: vi.fn(async () => true),
  temMfaVerificado: vi.fn(async () => false),
  origemDaRequisicao: () => ({}),
}));
vi.mock("@/lib/auth/rate-limit", () => ({ AUTH_LIMITS: {}, authRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { GET } from "./route";

const U = "11111111-1111-4111-8111-111111111111";
const req = () => new NextRequest("http://interno:3000/evalink/volta?code=c&state=s");

describe("GET /evalink/volta", () => {
  beforeEach(() => {
    vi.mocked(audit).mockClear();
    vi.mocked(decidirEntrada).mockResolvedValue({ ok: true, userId: U, email: "p@eva.test" });
    vi.mocked(abrirSessao).mockResolvedValue(true);
  });

  it("sem MFA: a página navega para /app", async () => {
    vi.mocked(temMfaVerificado).mockResolvedValue(false);
    const r = await GET(req());
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("url=/app\"");
    expect(html).not.toContain("/login/mfa");
  });

  it("com TOTP verificado: a página navega para /login/mfa?next=/app", async () => {
    vi.mocked(temMfaVerificado).mockResolvedValue(true);
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("url=/login/mfa?next=/app\"");
    expect(temMfaVerificado).toHaveBeenCalledWith(U);
  });

  it("checagem de MFA lança: falha segura para /login/mfa", async () => {
    vi.mocked(temMfaVerificado).mockRejectedValue(new Error("rede"));
    expect(await (await GET(req())).text()).toContain("/login/mfa?next=/app");
  });

  it("sem_org_padrao: redireciona com o motivo e audita com ele", async () => {
    vi.mocked(decidirEntrada).mockResolvedValue({ ok: false, motivo: "sem_org_padrao" });
    const r = await GET(req());
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://crm.test/login?evalink=sem_org_padrao");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.evalink_recusado", metadata: { motivo: "sem_org_padrao" } }),
    );
  });
});
