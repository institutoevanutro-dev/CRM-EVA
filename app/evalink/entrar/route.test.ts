// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/evalink/config", () => ({
  COOKIE_LOGIN: "evalink_login",
  COOKIE_VOLTA: "evalink_volta",
  configEvalink: () => ({ emissor: "https://conta.test/auth/v1" }),
}));
vi.mock("@/lib/evalink/oidc", () => ({
  inicioDoLogin: () => ({ url: "https://conta.test/auth/v1/oauth/authorize?x=1", cookie: "s.n.v" }),
}));
vi.mock("@/lib/auth/rate-limit", () => ({ AUTH_LIMITS: {}, authRateLimited: vi.fn(async () => false) }));

import { GET } from "./route";

const cookieDaVolta = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("evalink_volta="));

/** Auditoria de 17/11, item 53: a tela de origem atravessa o login pela Conta. */
describe("GET /evalink/entrar", () => {
  it("guarda o `next` interno para a volta", async () => {
    const r = await GET(new NextRequest("http://crm.test/evalink/entrar?next=%2Fapp%2Finbox%3Fc%3D7"));
    expect(r.status).toBe(302);
    expect(cookieDaVolta(r)).toMatch(/^evalink_volta=%2Fapp%2Finbox%3Fc%3D7;.*Path=\/evalink/i);
    expect(cookieDaVolta(r)).toMatch(/HttpOnly/i);
  });

  it("CONTROLE — destino externo não é guardado", async () => {
    const r = await GET(new NextRequest("http://crm.test/evalink/entrar?next=https%3A%2F%2Fevil.example"));
    expect(cookieDaVolta(r)).toMatch(/^evalink_volta=;/);
  });
});
