import { afterEach, describe, expect, it, vi } from "vitest";
import { enderecoDeRetornoDoInstagram, trocarCodePorTokenLongo, urlDeLogin } from "./oauth";

describe("login do Instagram", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("URL de login tem os escopos e o state", () => {
    const u = new URL(urlDeLogin("APPID", "https://crm.x/api/v1/channels/instagram/callback", "ST"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("APPID");
    expect(u.searchParams.get("redirect_uri")).toBe("https://crm.x/api/v1/channels/instagram/callback");
    expect(u.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
    );
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("ST");
  });

  it("endereço de retorno é a URL pública da instalação, sem barra dobrada", () => {
    expect(enderecoDeRetornoDoInstagram("https://crm.x/")).toBe("https://crm.x/api/v1/channels/instagram/callback");
  });

  it("troca code por token longo (resposta curta embrulhada em data[] ou plana)", async () => {
    for (const curta of [
      { data: [{ access_token: "CURTO", user_id: 42, permissions: "x" }] },
      { access_token: "CURTO", user_id: 42 },
    ]) {
      const chamadas: [string, RequestInit | undefined][] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          chamadas.push([url, init]);
          return new Response(
            JSON.stringify(url.includes("oauth/access_token") ? curta : { access_token: "LONGO", expires_in: 5_184_000 }),
            { status: 200 },
          );
        }),
      );
      const r = await trocarCodePorTokenLongo({ appId: "A", appSecret: "S" }, "CODE", "https://crm.x/cb");
      expect(r.token).toBe("LONGO");
      expect(r.userId).toBe("42");
      expect(r.expiraEm.getTime()).toBeGreaterThan(Date.now() + 5_000_000_000);
      const [, init] = chamadas[0]!;
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      const longa = new URL(chamadas[1]![0]);
      expect(longa.pathname).toBe("/access_token");
      expect(longa.searchParams.get("grant_type")).toBe("ig_exchange_token");
      expect(longa.searchParams.get("access_token")).toBe("CURTO");
    }
  });

  it("recusa da Meta vira erro sem token na mensagem", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(trocarCodePorTokenLongo({ appId: "A", appSecret: "S" }, "CODE", "https://crm.x/cb")).rejects.toThrow(
      "instagram_code_recusado_400",
    );
  });
});
