import { afterEach, describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { getWahaClient } from "@/lib/waha/client";

import { arquivarSessaoLegadaDoNumero, conferirToken, derrubarSessaoLegadaNoWaha, desarquivarSessaoLegada, ErroDaMeta, FALHA_GENERICA_DA_META, escolherNumero, gerarPin, numerosDaConta, pedirSincronizacao, registrarNumero, trocarCodigo } from "./cadastro-incorporado";

vi.mock("@/lib/waha/client", () => ({ getWahaClient: vi.fn(() => null) }));

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
  type Linha = { id: string; waha_session_name: string | null; phone_number: string | null; status?: string | null; status_reason?: string | null };
  function adminFalso(linhas: Linha[], erros: { select?: boolean; update?: boolean } = {}) {
    const filtros: Array<[string, unknown]> = [];
    const updates: Array<Record<string, unknown>> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filtros.push([c, v]); return q; };
    q.is = () => q;
    q.not = () => q;
    q.then = (ok: (r: unknown) => unknown) => ok({ data: linhas, error: erros.select ? { message: "boom", code: "XX000" } : null });
    const u: Record<string, unknown> = {};
    u.eq = (c: string, v: unknown) => { filtros.push([c, v]); return u; };
    u.then = (ok: (r: unknown) => unknown) => ok({ error: erros.update ? { message: "boom" } : null });
    q.update = (x: Record<string, unknown>) => { updates.push(x); return u; };
    return { admin: { from: () => q } as never, filtros, updates };
  }
  it("sem sessão WAHA ativa com o número, devolve null e não escreve", async () => {
    const { admin, updates } = adminFalso([{ id: "s0", waha_session_name: null, phone_number: "+5511900000000" }]);
    expect(await arquivarSessaoLegadaDoNumero(admin, "org1", "+55 27 99904-9879")).toBeNull();
    expect(updates).toEqual([]);
  });
  it("casa o número formatado da Meta com a linha WAHA gravada em outro formato (com/sem +, com/sem o 9)", async () => {
    for (const gravado of ["+5527999049879", "5527999049879@c.us", "552799049879", "27 99904-9879".replace(/^/, "55 ")]) {
      const { admin, filtros, updates } = adminFalso([{ id: "s1", waha_session_name: null, phone_number: gravado }]);
      expect((await arquivarSessaoLegadaDoNumero(admin, "org1", "+55 27 99904-9879"))?.id, gravado).toBe("s1");
      expect(filtros).toContainEqual(["organization_id", "org1"]);
      expect(filtros).toContainEqual(["provider", "waha"]);
      expect(updates[0]).toMatchObject({ status: "STOPPED", status_reason: "substituida_pela_coexistencia" });
    }
  });
  it("erro ao ler as sessões lança (não vira 'não havia sessão')", async () => {
    const { admin } = adminFalso([], { select: true });
    await expect(arquivarSessaoLegadaDoNumero(admin, "org1", "+5527999049879")).rejects.toThrow();
  });
  it("erro no UPDATE lança ANTES de tocar o WAHA", async () => {
    const { admin } = adminFalso([{ id: "s1", waha_session_name: "sess", phone_number: "+5527999049879" }], { update: true });
    const logout = vi.fn();
    vi.mocked(getWahaClient).mockReturnValue({ logoutSession: logout, deleteSession: logout } as never);
    await expect(arquivarSessaoLegadaDoNumero(admin, "org1", "+5527999049879")).rejects.toThrow();
    expect(logout).not.toHaveBeenCalled();
  });
  it("só arquiva NO BANCO e devolve o que desfaz (id, sessão WAHA, status anterior) — o WAHA fica intacto", async () => {
    const { admin } = adminFalso([{ id: "s1", waha_session_name: "sess", phone_number: "+5527999049879", status: "WORKING", status_reason: null }]);
    const logout = vi.fn();
    vi.mocked(getWahaClient).mockReturnValue({ logoutSession: logout, deleteSession: logout } as never);
    expect(await arquivarSessaoLegadaDoNumero(admin, "org1", "+5527999049879")).toEqual({
      id: "s1", wahaSessionName: "sess", statusAnterior: "WORKING", statusReasonAnterior: null,
    });
    expect(logout).not.toHaveBeenCalled();
  });
  it("desarquivar devolve a linha (archived_at nulo, status anterior), filtrando organização e id", async () => {
    const { admin, filtros, updates } = adminFalso([]);
    await desarquivarSessaoLegada(admin, "org1", { id: "s1", wahaSessionName: "sess", statusAnterior: "WORKING", statusReasonAnterior: null });
    expect(updates[0]).toMatchObject({ archived_at: null, status: "WORKING", status_reason: null });
    expect(filtros).toEqual(expect.arrayContaining([["organization_id", "org1"], ["id", "s1"]]));
  });
  it("derrubar no WAHA faz logout e delete, e erro do WAHA não lança", async () => {
    const logout = vi.fn(async () => { throw new Error("waha fora"); });
    vi.mocked(getWahaClient).mockReturnValue({ logoutSession: logout, deleteSession: vi.fn() } as never);
    await expect(derrubarSessaoLegadaNoWaha("org1", { id: "s1", wahaSessionName: "sess", statusAnterior: "WORKING", statusReasonAnterior: null })).resolves.toBeUndefined();
    expect(logout).toHaveBeenCalledWith("sess");
  });
});

describe("falhas cruas não chegam à tela", () => {
  it("fetch que explode vira ErroDaMeta com a frase genérica, e o cru fica em .detalhe", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    const e = await trocarCodigo(APP, "x").catch((x) => x);
    expect(e).toBeInstanceOf(ErroDaMeta);
    expect(e.message).toBe(FALHA_GENERICA_DA_META);
    expect(e.detalhe).toMatch(/fetch failed/);
  });
  it("conferirToken e pedirSincronizacao devolvem a frase genérica", async () => {
    graphFalsa({ "/debug_token": { status: 500, body: { error: { message: "Internal" } } }, "/smb_app_data": { body: {} } });
    expect(await conferirToken(APP, "t")).toEqual({ ok: false, motivo: FALHA_GENERICA_DA_META });
    expect(await pedirSincronizacao("t", "1", "history")).toEqual({ erro: FALHA_GENERICA_DA_META });
  });
  it("name é ErroDaMeta", () => {
    expect(new ErroDaMeta(1, null, "x").name).toBe("ErroDaMeta");
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
