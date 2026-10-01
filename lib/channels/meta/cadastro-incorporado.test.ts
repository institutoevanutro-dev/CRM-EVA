import { afterEach, describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { arquivarSessaoLegadaDoNumero, conferirToken, ErroDaMeta, escolherNumero, gerarPin, numerosDaConta, pedirSincronizacao, registrarNumero, trocarCodigo } from "./cadastro-incorporado";

const APP = { appId: "1054112660758768", appSecret: "s".repeat(32) };
const chamadas: Array<{ url: string; init?: RequestInit }> = [];
function graphFalsa(respostas: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    const chave = Object.keys(respostas).find((k) => url.includes(k));
    const r = chave ? respostas[chave]! : { status: 404, body: { error: { message: "não simulado" } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => { vi.unstubAllGlobals(); chamadas.length = 0; });

describe("trocarCodigo", () => {
  it("troca o code pelo token do system user do cliente", async () => {
    graphFalsa({ "/oauth/access_token": { body: { access_token: "EAAX" } } });
    expect(await trocarCodigo(APP, "AQB")).toBe("EAAX");
    expect(chamadas[0]!.url).toContain(`client_id=${APP.appId}`);
    expect(chamadas[0]!.url).toContain("code=AQB");
  });
  it("code vencido vira ErroDaMeta com o código da Meta", async () => {
    graphFalsa({ "/oauth/access_token": { status: 400, body: { error: { message: "expired", code: 100, error_subcode: 36007 } } } });
    await expect(trocarCodigo(APP, "velho")).rejects.toMatchObject({ codigo: 100, subcodigo: 36007 });
  });
  it("200 sem access_token também é erro", async () => {
    graphFalsa({ "/oauth/access_token": { body: {} } });
    await expect(trocarCodigo(APP, "x")).rejects.toBeInstanceOf(ErroDaMeta);
  });
});

describe("conferirToken", () => {
  const escopos = ["whatsapp_business_management", "whatsapp_business_messaging"];
  it("token de outro app é recusado", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: "999", is_valid: true, scopes: escopos } } } });
    expect(await conferirToken(APP, "t")).toMatchObject({ ok: false });
  });
  it("token inválido é recusado", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: APP.appId, is_valid: false, scopes: escopos } } } });
    expect(await conferirToken(APP, "t")).toMatchObject({ ok: false });
  });
  it("sem o escopo de mensagens é recusado", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: APP.appId, is_valid: true, scopes: ["whatsapp_business_management"] } } } });
    expect(await conferirToken(APP, "t")).toMatchObject({ ok: false });
  });
  it("app certo, válido e com os dois escopos passa", async () => {
    graphFalsa({ "/debug_token": { body: { data: { app_id: APP.appId, is_valid: true, scopes: escopos } } } });
    expect(await conferirToken(APP, "t")).toEqual({ ok: true });
    expect(chamadas[0]!.url).toContain(`access_token=${APP.appId}%7C`);
  });
});

describe("numerosDaConta", () => {
  it("lê id, número e is_on_biz_app", async () => {
    graphFalsa({ "/phone_numbers": { body: { data: [{ id: "1", display_phone_number: "+55 27 99904-9879", is_on_biz_app: true }, { id: "2" }] } } });
    expect(await numerosDaConta("t", "222")).toEqual([
      { id: "1", displayPhoneNumber: "+55 27 99904-9879", isOnBizApp: true },
      { id: "2", displayPhoneNumber: null, isOnBizApp: false },
    ]);
  });
});

describe("escolherNumero", () => {
  const n = (id: string, biz: boolean) => ({ id, displayPhoneNumber: "+55 27 99904-9879", isOnBizApp: biz });
  it("coexistência exige is_on_biz_app", () => {
    expect(escolherNumero([n("1", false)], { phoneNumberId: null, coexistencia: true })).toMatchObject({ ok: false });
    expect(escolherNumero([n("1", true)], { phoneNumberId: null, coexistencia: true })).toEqual({ ok: true, numero: n("1", true) });
  });
  it("com phone_number_id informado, tem de estar na conta", () => {
    expect(escolherNumero([n("1", true)], { phoneNumberId: "2", coexistencia: true })).toMatchObject({ ok: false });
  });
  it("número novo sem id e com um só número na conta usa esse", () => {
    expect(escolherNumero([n("7", false)], { phoneNumberId: null, coexistencia: false })).toEqual({ ok: true, numero: n("7", false) });
  });
  it("número novo, sem id e com vários números, recusa", () => {
    expect(escolherNumero([n("7", false), n("8", false)], { phoneNumberId: null, coexistencia: false })).toMatchObject({ ok: false });
  });
});

describe("registrarNumero", () => {
  it("POST register com o pin, token em Authorization", async () => {
    graphFalsa({ "/111/register": { body: { success: true } } });
    await registrarNumero("tok", "111", "123456");
    expect(chamadas[0]!.init?.method).toBe("POST");
    expect(String(chamadas[0]!.init?.body)).toContain('"pin":"123456"');
    expect((chamadas[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("pedirSincronizacao", () => {
  it("manda sync_type e devolve o request_id", async () => {
    graphFalsa({ "/smb_app_data": { body: { request_id: "req-1" } } });
    expect(await pedirSincronizacao("t", "111", "history")).toEqual({ request_id: "req-1" });
    expect(String(chamadas[0]!.init?.body)).toContain("sync_type=history");
  });
  it("erro da Meta vira texto, nunca throw (a conexão já está gravada)", async () => {
    graphFalsa({ "/smb_app_data": { status: 400, body: { error: { message: "x", code: 100, error_subcode: 2593109 } } } });
    expect(await pedirSincronizacao("t", "111", "history")).toMatchObject({ erro: expect.stringMatching(/não compartilhou/) });
  });
});

describe("arquivarSessaoLegadaDoNumero", () => {
  function adminFalso(linha: { id: string; waha_session_name: string | null } | null) {
    const filtros: Array<[string, unknown]> = [];
    const updates: Array<Record<string, unknown>> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filtros.push([c, v]); return q; };
    q.is = () => q;
    q.maybeSingle = async () => ({ data: linha, error: null });
    q.update = (u: Record<string, unknown>) => { updates.push(u); return q; };
    return { admin: { from: () => q } as never, filtros, updates };
  }
  it("sem sessão WAHA ativa com o número, devolve null e não escreve", async () => {
    const { admin, updates } = adminFalso(null);
    expect(await arquivarSessaoLegadaDoNumero(admin, "org1", "+5527999049879")).toBeNull();
    expect(updates).toEqual([]);
  });
  it("arquiva a sessão WAHA do número, só dentro da organização", async () => {
    const { admin, filtros, updates } = adminFalso({ id: "s1", waha_session_name: null });
    expect(await arquivarSessaoLegadaDoNumero(admin, "org1", "+5527999049879")).toBe("s1");
    expect(filtros).toContainEqual(["organization_id", "org1"]);
    expect(filtros).toContainEqual(["provider", "waha"]);
    expect(updates[0]).toMatchObject({ status: "STOPPED", status_reason: "substituida_pela_coexistencia" });
  });
});

it("gerarPin tem 6 dígitos", () => {
  expect(gerarPin()).toMatch(/^\d{6}$/);
});

it("ErroDaMeta carrega a mensagem em português quando o código é conhecido", () => {
  expect(new ErroDaMeta(100, 3441041, "raw").message).toMatch(/outra conta/);
});

it("toda frase voltada ao usuário tem entrada em espanhol (ruling P13)", async () => {
  const { MENSAGENS_DA_META_PARA_O_USUARIO } = await import("./coexistencia");
  const { MOTIVOS_DO_CADASTRO } = await import("./cadastro-incorporado");
  for (const frase of [...MENSAGENS_DA_META_PARA_O_USUARIO, ...MOTIVOS_DO_CADASTRO]) {
    expect(DICIONARIO[frase]?.es, frase).toBeTruthy();
  }
});
