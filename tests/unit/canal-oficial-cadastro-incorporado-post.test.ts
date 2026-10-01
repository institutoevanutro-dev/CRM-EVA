import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/channels/official/cadastro-incorporado — o `code` do botão da Meta
 * vira canal oficial pelo MESMO caminho do formulário (`conectarCanalOficial`).
 * Coexistência não registra o número e pede contatos + histórico; número novo
 * registra com PIN (cifrado, nunca devolvido nem logado).
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "aaaaaaaa-0000-4000-8000-000000000001";

const m = vi.hoisted(() => ({
  trocar: vi.fn(async (): Promise<string> => "EAAX"),
  conferir: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; motivo: string }),
  numeros: vi.fn(async () => [{ id: "111222333", displayPhoneNumber: "+55 27 99904-9879", isOnBizApp: true }]),
  registrar: vi.fn(async (..._a: unknown[]) => undefined),
  sincronizar: vi.fn(),
  arquivar: vi.fn(async (..._a: unknown[]): Promise<string | null> => "sessao-waha-antiga"),
  conectar: vi.fn(),
  avisos: [] as Array<[string, Record<string, unknown>]>,
  auditorias: [] as Array<Record<string, unknown>>,
  idioma: "pt-BR" as "pt-BR" | "es",
}));

vi.mock("@/lib/channels/meta/cadastro-incorporado", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/meta/cadastro-incorporado")>()),
  trocarCodigo: m.trocar,
  conferirToken: m.conferir,
  numerosDaConta: m.numeros,
  registrarNumero: m.registrar,
  gerarPin: () => "123456",
  pedirSincronizacao: m.sincronizar,
  arquivarSessaoLegadaDoNumero: m.arquivar,
  // escolherNumero e ErroDaMeta: os ORIGINAIS (puros)
}));
vi.mock("@/lib/channels/meta/conectar-canal-oficial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/meta/conectar-canal-oficial")>()),
  conectarCanalOficial: m.conectar,
  // gravarCoexistencia: a ORIGINAL, que grava no banco falso
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u1", idioma: m.idioma, is_platform_admin: false }, org: { orgId: ORG, role: "admin" } }),
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appId: "1234567890", appSecret: "segredo-do-app", esConfigId: "cfg-1", verifyToken: "v" }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "\\x_pin_cifrado" }));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void m.auditorias.push(e) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: (msg: string, ctx: Record<string, unknown>) => void m.avisos.push([msg, ctx]), info: () => undefined, error: () => undefined, debug: () => undefined },
}));

interface Db {
  metadata: Record<string, unknown>;
  updates: Array<{ patch: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
}
const db: Db = { metadata: {}, updates: [] };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const filtros: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filtros.push([k, v]), q),
        is: () => q,
        maybeSingle: async () => ({ data: { metadata: structuredClone(db.metadata) }, error: null }),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        then: (res: (v: unknown) => unknown) => {
          if (patch) {
            db.updates.push({ patch, filtros });
            if (patch.metadata) db.metadata = patch.metadata as Record<string, unknown>;
          }
          return Promise.resolve({ error: null }).then(res);
        },
      };
      return q;
    },
  }),
}));

import { ErroDaMeta, FALHA_GENERICA_DA_META } from "@/lib/channels/meta/cadastro-incorporado";
import { POST } from "@/app/api/v1/channels/official/cadastro-incorporado/route";

const COEX = { code: "AQBx1234567890", evento: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", waba_id: "222333444555", phone_number_id: null };
const NOVO = { ...COEX, evento: "FINISH" };
const conectado = { ok: true, sessionId: CANAL, displayName: "Clínica", phoneNumber: "+5527999049879", webhook: { assinado: true } };

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/channels/official/cadastro-incorporado", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.sincronizar.mockReset();
  m.avisos.length = 0;
  m.auditorias.length = 0;
  m.idioma = "pt-BR";
  db.metadata = {};
  db.updates = [];
  m.conectar.mockResolvedValue(conectado);
  m.sincronizar.mockResolvedValueOnce({ request_id: "c-1" }).mockResolvedValueOnce({ request_id: "h-1" });
});

describe("POST /channels/official/cadastro-incorporado", () => {
  it("coexistência: arquiva a sessão legada ANTES de conectar, não registra, pede contatos e histórico, grava metadata.coexistencia e audita sem token", async () => {
    const res = await POST(req(COEX));
    expect(res.status).toBe(200);
    expect(m.registrar).not.toHaveBeenCalled();
    expect(m.arquivar).toHaveBeenCalledWith(expect.anything(), ORG, "+5527999049879");
    // ordem (ruling P1): o índice (org, phone_number) ativo ainda tem a linha WAHA
    expect(m.arquivar.mock.invocationCallOrder[0]!).toBeLessThan(m.conectar.mock.invocationCallOrder[0]!);
    expect(m.conectar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, phoneNumberId: "111222333", wabaId: "222333444555", token: "EAAX" }),
    );
    expect(m.sincronizar.mock.calls.map((c) => c[2])).toEqual(["smb_app_state_sync", "history"]);
    const escrita = db.updates.at(-1)!;
    expect(escrita.patch.metadata).toMatchObject({ coexistencia: { pedidos: { contatos: { request_id: "c-1" }, historico: { request_id: "h-1" } } } });
    expect(escrita.filtros).toEqual(expect.arrayContaining([["organization_id", ORG], ["id", CANAL]]));
    expect(JSON.stringify(m.auditorias)).not.toContain("EAAX");
    expect(m.auditorias[0]).toMatchObject({ action: "channel.official_connected_es", metadata: { coexistencia: true, sessao_legada_arquivada: "sessao-waha-antiga" } });
    expect(await res.json()).toMatchObject({ data: { connected: true, coexistencia: true, displayName: "Clínica" } });
  });

  it("número novo (FINISH): registra com o PIN, guarda o PIN cifrado na metadata e não pede sincronização", async () => {
    const res = await POST(req(NOVO));
    expect(res.status).toBe(200);
    expect(m.registrar).toHaveBeenCalledTimes(1);
    expect(m.registrar).toHaveBeenCalledWith("EAAX", "111222333", "123456");
    expect(m.sincronizar).not.toHaveBeenCalled();
    const entrada = m.conectar.mock.calls[0]![1] as { metadataExtra?: Record<string, unknown> };
    expect(entrada.metadataExtra).toMatchObject({ pin_cifrado: "\\x_pin_cifrado", cadastro_incorporado: { evento: "FINISH" } });
    expect(JSON.stringify(entrada.metadataExtra)).not.toContain("123456");
    expect(db.updates.some((u) => "coexistencia" in ((u.patch.metadata as Record<string, unknown> | undefined) ?? {}))).toBe(false);
    const corpo = await res.json();
    expect(corpo).toMatchObject({ data: { coexistencia: false } });
    expect(JSON.stringify([corpo, m.auditorias, m.avisos])).not.toContain("123456");
  });

  it("número novo: o register vem DEPOIS da conexão gravada (o PIN cifrado já está salvo quando a Meta é chamada)", async () => {
    await POST(req(NOVO));
    expect(m.conectar.mock.invocationCallOrder[0]!).toBeLessThan(m.registrar.mock.invocationCallOrder[0]!);
  });

  it("número novo com conexão recusada: register NÃO é chamado", async () => {
    m.conectar.mockResolvedValueOnce({ ok: false, status: 422, codigo: "invalid_request", motivo: "este número já está conectado em outra organização" });
    const res = await POST(req(NOVO));
    expect(res.status).toBe(422);
    expect(m.registrar).not.toHaveBeenCalled();
  });

  it("número novo com register recusado: 422 traduzido, mas a sessão e o pin_cifrado ficam gravados", async () => {
    m.registrar.mockRejectedValueOnce(new ErroDaMeta(100, 133005, "Two step verification PIN mismatch"));
    m.idioma = "es";
    const res = await POST(req(NOVO));
    expect(res.status).toBe(422);
    const msg = (await res.json()).error.message as string;
    expect(msg).not.toContain("PIN mismatch");
    expect(msg).toBe("No fue posible completar la conexión con Meta. Inténtelo de nuevo en unos instantes; si persiste, repita el flujo.");
    expect(m.conectar).toHaveBeenCalledTimes(1);
    expect((m.conectar.mock.calls[0]![1] as { metadataExtra: Record<string, unknown> }).metadataExtra).toMatchObject({ pin_cifrado: "\\x_pin_cifrado" });
  });

  it("motivo cru da Meta (fora do dicionário) vindo do conectarCanalOficial: frase genérica na tela, cru no log", async () => {
    m.conectar.mockResolvedValueOnce({ ok: false, status: 422, codigo: "invalid_request", motivo: "(#100) Invalid parameter phone_number_id" });
    const res = await POST(req(COEX));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe(FALHA_GENERICA_DA_META);
    expect(JSON.stringify(m.avisos)).toContain("Invalid parameter");
  });

  it("falha no smb_app_data não desfaz a conexão: 200 com o erro gravado em pedidos.historico", async () => {
    m.sincronizar.mockReset().mockResolvedValueOnce({ request_id: "c-1" }).mockResolvedValueOnce({ erro: "x" });
    const res = await POST(req(COEX));
    expect(res.status).toBe(200);
    expect(db.updates.at(-1)?.patch.metadata).toMatchObject({ coexistencia: { pedidos: { contatos: { request_id: "c-1" }, historico: { erro: "x" } } } });
  });

  it("token de outro app → 422 sem gravar nada", async () => {
    m.conferir.mockResolvedValueOnce({ ok: false, motivo: "O token devolvido não é do app desta instalação." });
    m.idioma = "es";
    const res = await POST(req(COEX));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("El token devuelto no es de la app de esta instalación.");
    expect(m.conectar).not.toHaveBeenCalled();
    expect(m.arquivar).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
    expect(m.auditorias).toHaveLength(0);
  });

  it("code vencido → 422 com a frase genérica (o texto cru da Meta só vai ao log)", async () => {
    m.trocar.mockRejectedValueOnce(new ErroDaMeta(100, 36007, "This authorization code has expired"));
    const res = await POST(req(COEX));
    expect(res.status).toBe(422);
    const msg = (await res.json()).error.message as string;
    expect(msg).toBe(FALHA_GENERICA_DA_META);
    expect(msg).not.toContain("expired");
    expect(JSON.stringify(m.avisos)).toContain("expired");
    expect(m.conectar).not.toHaveBeenCalled();
  });

  it("evento que não é de término (CANCEL) → 422 antes de falar com a Meta", async () => {
    const res = await POST(req({ ...COEX, evento: "CANCEL" }));
    expect(res.status).toBe(422);
    expect(m.trocar).not.toHaveBeenCalled();
  });

  it("body curto demais (code < 10, waba_id < 5) → 422 do Zod", async () => {
    expect((await POST(req({ ...COEX, code: "AQB" }))).status).toBe(422);
    expect((await POST(req({ ...COEX, waba_id: "222" }))).status).toBe(422);
    expect(m.trocar).not.toHaveBeenCalled();
  });

  it("conexão recusada (número em outra org, 422 do conectarCanalOficial) sobe com a frase traduzida e não pede sincronização", async () => {
    m.conectar.mockResolvedValueOnce({ ok: false, status: 422, codigo: "invalid_request", motivo: "este número já está conectado em outra organização" });
    m.idioma = "es";
    const res = await POST(req(COEX));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/otra organización/);
    expect(m.sincronizar).not.toHaveBeenCalled();
    expect(m.auditorias).toHaveLength(0);
  });
});
