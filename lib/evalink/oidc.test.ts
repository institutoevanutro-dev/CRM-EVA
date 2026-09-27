// @vitest-environment node
// jose assina com ES256 via WebCrypto; sob jsdom (o default da suíte) o Uint8Array
// do jsdom e o do node são de realms diferentes e o `instanceof` interno do jose falha.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sobeContaFalsa } from "../../tests/helpers/conta-falsa";
import { configEvalink, type ConfigEvalink } from "./config";
import { conferirVolta, inicioDoLogin } from "./oidc";

let conta: Awaited<ReturnType<typeof sobeContaFalsa>>; let cfg: ConfigEvalink;

beforeAll(async () => {
  conta = await sobeContaFalsa();
  cfg = configEvalink({ CONTA_URL: conta.url, EVALINK_CLIENT_ID: conta.clientId, EVALINK_CLIENT_SECRET: conta.clientSecret,
    EVALINK_SEGREDO_AVISO: "s".repeat(32), EVALINK_ORG_PADRAO: "11111111-1111-4111-8111-111111111111",
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.test" })!;
});
afterAll(() => conta.fecha());
beforeEach(() => conta.tokens({}));

/** faz o caminho do navegador: /entrar -> authorize (a Conta falsa aprova) -> pega code e state da volta */
async function ida() {
  const { url, cookie } = inicioDoLogin(cfg);
  const r = await fetch(url, { redirect: "manual" });
  const volta = new URL(r.headers.get("location")!);
  return { code: volta.searchParams.get("code"), state: volta.searchParams.get("state"), cookie, url: new URL(url) };
}

describe("inicioDoLogin", () => {
  it("manda PKCE S256, state, nonce, escopo e a volta exata", async () => {
    const { url, cookie } = inicioDoLogin(cfg);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${conta.url}/auth/v1/oauth/authorize`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://crm.exemplo.test/evalink/volta");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    const [state, nonce, verificador] = cookie.split(".");
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("nonce")).toBe(nonce);
    expect(verificador!.length).toBeGreaterThanOrEqual(43);
  });
});

describe("conferirVolta", () => {
  it("caminho feliz devolve sub, e-mail, nome e papel", async () => {
    expect(await conferirVolta(cfg, await ida())).toEqual({
      sub: "11111111-1111-4111-8111-111111111111", email: "pessoa@eva.test", nome: "Pessoa Fictícia", papel: "agent" });
  });
  it("name igual ao e-mail (a Conta de hoje) vira nome vazio", async () => {
    conta.tokens({ nome: " Pessoa@Eva.Test " });
    expect((await conferirVolta(cfg, await ida()))?.nome).toBe("");
  });
  it("state diferente do cookie: null", async () => {
    const v = await ida(); expect(await conferirVolta(cfg, { ...v, state: "outro" })).toBeNull();
  });
  it("sem cookie: null", async () => {
    const v = await ida(); expect(await conferirVolta(cfg, { ...v, cookie: undefined })).toBeNull();
  });
  it("nonce trocado: null", async () => {
    conta.tokens({ nonce: "outro" }); expect(await conferirVolta(cfg, await ida())).toBeNull();
  });
  it("token de outro cliente: null", async () => {
    conta.tokens({ clientId: "outro-cliente" }); expect(await conferirVolta(cfg, await ida())).toBeNull();
  });
  it("papel fora da lista, nulo ou vazio: null", async () => {
    for (const papel of ["dono", null, ""]) { conta.tokens({ papel }); expect(await conferirVolta(cfg, await ida())).toBeNull(); }
  });
  it("HS256 é recusado", async () => {
    conta.tokens({ alg: "HS256" }); expect(await conferirVolta(cfg, await ida())).toBeNull();
  });
  it("emissor errado: null", async () => {
    conta.tokens({ emissor: "https://outra.test/auth/v1" }); expect(await conferirVolta(cfg, await ida())).toBeNull();
  });
  it("Conta recusa a troca: null", async () => {
    conta.tokens({ status: 400 }); expect(await conferirVolta(cfg, await ida())).toBeNull();
  });
});
