// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { decidirEntrada } from "@/lib/evalink/entrada";
import { abrirSessao, temMfaVerificado } from "@/lib/evalink/sessao";

vi.mock("@/lib/evalink/config", () => ({
  COOKIE_LOGIN: "evalink_login",
  COOKIE_VOLTA: "evalink_volta",
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

  // Auditoria de 17/11, item 53: quem chegava por um link (ex.: aviso de conversa)
  // e entrava pelo EvaLink caía sempre no início.
  it("volta para a tela de onde a pessoa veio, guardada no cookie da entrada", async () => {
    vi.mocked(temMfaVerificado).mockResolvedValue(false);
    const comVolta = new NextRequest("http://interno:3000/evalink/volta?code=c&state=s", {
      headers: { cookie: "evalink_volta=%2Fapp%2Finbox%3Fc%3D7%26aba%3Dfila" },
    });
    const r = await GET(comVolta);
    expect(await r.text()).toContain('url=/app/inbox?c=7&amp;aba=fila"');
    // O cookie da volta é apagado junto com o do login.
    expect(r.headers.getSetCookie().some((c) => c.startsWith("evalink_volta=;"))).toBe(true);
  });

  it("com MFA, a tela de origem segue como `next` do desafio", async () => {
    vi.mocked(temMfaVerificado).mockResolvedValue(true);
    const comVolta = new NextRequest("http://interno:3000/evalink/volta?code=c&state=s", {
      headers: { cookie: "evalink_volta=%2Fapp%2Finbox%3Fc%3D7%26aba%3Dfila" },
    });
    expect(await (await GET(comVolta)).text()).toContain('url=/login/mfa?next=/app/inbox?c=7%26aba=fila"');
  });

  it("CONTROLE — destino externo no cookie cai no início", async () => {
    vi.mocked(temMfaVerificado).mockResolvedValue(false);
    const forjado = new NextRequest("http://interno:3000/evalink/volta?code=c&state=s", {
      headers: { cookie: "evalink_volta=%2F%2Fevil.example" },
    });
    const html = await (await GET(forjado)).text();
    expect(html).toContain('url=/app"');
    expect(html).not.toContain("evil.example");
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
