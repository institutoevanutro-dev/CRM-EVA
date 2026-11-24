/**
 * /api/v1/agenda/clinicorp — o que é DA ROTA: o token só entra (cifrado, nunca
 * volta, nunca vai à auditoria), a organização vem da sessão, a pessoa do
 * mapeamento tem de ser da equipe. Banco em memória; dados fictícios.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async () => "\\xcifrado") }));

const { GET, PUT, PATCH, DELETE } = await import("./route");
const { POST: GERAR_WEBHOOK } = await import("./webhook/route");
const { POST: IMPORTAR } = await import("./importar/route");

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "44444444-4444-4444-8444-444444444444";
const GESTOR = "11111111-1111-4111-8111-111111111111";
const DRA = "33333333-3333-4333-8333-333333333333";
const ESTRANHA = "55555555-5555-4555-8555-555555555555";
const TOKEN = "token-ficticio-que-nao-pode-vazar";

let db: ReturnType<typeof supabaseEmMemoria>;

const pedir = (metodo: string, corpo?: unknown) =>
  new NextRequest("http://localhost/api/v1/agenda/clinicorp", {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  db = supabaseEmMemoria({
    calendar_clinicorp_integrations: [],
    calendar_clinicorp_professionals: [],
    calendar_clinicorp_events: [],
    user_organizations: [
      { organization_id: ORG, user_id: DRA, revoked_at: null },
      { organization_id: OUTRA, user_id: ESTRANHA, revoked_at: null },
    ],
  });
  vi.mocked(createAdminClient).mockReturnValue(db.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: GESTOR, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "manager" },
  } as never);
});

describe("a credencial", () => {
  it("entra cifrada, na organização da SESSÃO; não volta no GET nem vai à auditoria", async () => {
    const res = await PUT(pedir("PUT", { usuario_api: "usuario-ficticio", token_api: TOKEN, assinante: "" }));
    expect(res.status).toBe(200);
    expect(encryptWebhookSecret).toHaveBeenCalledWith(db.cliente, TOKEN);
    expect(db.tabelas.calendar_clinicorp_integrations).toEqual([
      expect.objectContaining({ organization_id: ORG, api_user: "usuario-ficticio", api_token_encrypted: "\\xcifrado", subscriber_id: null }),
    ]);

    const lido = await (await GET()).text();
    expect(lido).not.toContain(TOKEN);
    expect(lido).not.toContain("cifrado");
    expect(JSON.parse(lido).data).toMatchObject({ configurada: true, usuario_api: "usuario-ficticio" });

    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(TOKEN);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "agenda.clinicorp_credencial_salva",
      organizationId: ORG,
      metadata: { primeira_vez: true, token_trocado: true },
    });
  });

  it("organização no corpo é recusada (o schema é estrito)", async () => {
    const res = await PUT(pedir("PUT", { usuario_api: "u", token_api: TOKEN, organization_id: OUTRA }));
    expect(res.status).toBe(422);
    expect(db.tabelas.calendar_clinicorp_integrations).toEqual([]);
  });

  it("a primeira vez exige o token; depois, trocar só o usuário mantém o guardado", async () => {
    expect((await PUT(pedir("PUT", { usuario_api: "u" }))).status).toBe(422);
    await PUT(pedir("PUT", { usuario_api: "u", token_api: TOKEN }));
    vi.mocked(encryptWebhookSecret).mockClear();
    expect((await PUT(pedir("PUT", { usuario_api: "u2" }))).status).toBe(200);
    expect(encryptWebhookSecret).not.toHaveBeenCalled();
    expect(db.tabelas.calendar_clinicorp_integrations?.[0]).toMatchObject({ api_user: "u2", api_token_encrypted: "\\xcifrado" });
  });

  it("sem a chave de cifra na instalação, não grava nada", async () => {
    vi.mocked(encryptWebhookSecret).mockResolvedValueOnce(null);
    expect((await PUT(pedir("PUT", { usuario_api: "u", token_api: TOKEN }))).status).toBe(422);
    expect(db.tabelas.calendar_clinicorp_integrations).toEqual([]);
  });

  it("sem papel de gestor, nada acontece", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
    } as never);
    expect((await PUT(pedir("PUT", { usuario_api: "u", token_api: TOKEN }))).status).toBe(403);
    expect(db.tabelas.calendar_clinicorp_integrations).toEqual([]);
  });
});

describe("quem é quem", () => {
  beforeEach(() => {
    db.tabelas.calendar_clinicorp_integrations!.push({ organization_id: ORG, api_user: "u" });
    db.tabelas.calendar_clinicorp_professionals!.push(
      { organization_id: ORG, professional_id: "9001", name: "Dra. Fictícia", user_id: null },
      { organization_id: OUTRA, professional_id: "9001", name: "De outra casa", user_id: null },
    );
  });

  it("liga o profissional à pessoa da equipe, só nesta organização", async () => {
    const res = await PATCH(pedir("PATCH", { profissionais: [{ professional_id: "9001", user_id: DRA }] }));
    expect(res.status).toBe(200);
    expect(db.tabelas.calendar_clinicorp_professionals).toEqual([
      expect.objectContaining({ organization_id: ORG, user_id: DRA }),
      expect.objectContaining({ organization_id: OUTRA, user_id: null }),
    ]);
  });

  it("pessoa de fora da equipe é recusada", async () => {
    const res = await PATCH(pedir("PATCH", { profissionais: [{ professional_id: "9001", user_id: ESTRANHA }] }));
    expect(res.status).toBe(422);
    expect(db.tabelas.calendar_clinicorp_professionals!.every((p) => p.user_id === null)).toBe(true);
  });
});

describe("desligar", () => {
  it("apaga só a desta organização", async () => {
    db.tabelas.calendar_clinicorp_integrations!.push({ organization_id: ORG }, { organization_id: OUTRA });
    expect((await DELETE()).status).toBe(200);
    expect(db.tabelas.calendar_clinicorp_integrations).toEqual([{ organization_id: OUTRA }]);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({ action: "agenda.clinicorp_desligada", organizationId: ORG });
  });
});

describe("o endereço do webhook (0434)", () => {
  const caminhoDe = async (res: Response) => ((await res.json()) as { data: { caminho: string } }).data.caminho;
  const tokenDe = (caminho: string) => caminho.split("/").at(-1)!;

  it("nasce sem credencial da API; o token volta UMA vez e só o hash é gravado, nem na auditoria", async () => {
    const res = await GERAR_WEBHOOK();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const caminho = await caminhoDe(res);
    expect(caminho).toMatch(/^\/api\/v1\/webhooks\/clinicorp\/[0-9a-f]{64}$/);
    const token = tokenDe(caminho);

    const [linha] = db.tabelas.calendar_clinicorp_integrations!;
    expect(linha).toMatchObject({ organization_id: ORG, webhook_token_hash: createHash("sha256").update(token).digest("hex") });
    expect(linha!.api_user).toBeUndefined();
    expect(JSON.stringify(db.tabelas)).not.toContain(token);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(token);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(linha!.webhook_token_hash as string);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "agenda.clinicorp_webhook_gerado",
      organizationId: ORG,
      metadata: { trocou_endereco: false },
    });

    // O GET diz que há endereço e o que chegou nele, nunca o hash.
    const lido = await (await GET()).text();
    expect(lido).not.toContain(token);
    expect(lido).not.toContain(linha!.webhook_token_hash as string);
    expect(JSON.parse(lido).data).toMatchObject({ configurada: true, credencial: false, webhook: { ativo: true } });
  });

  it("gerar de novo troca o endereço: o hash anterior some", async () => {
    const primeiro = tokenDe(await caminhoDe(await GERAR_WEBHOOK()));
    const segundo = tokenDe(await caminhoDe(await GERAR_WEBHOOK()));
    expect(segundo).not.toBe(primeiro);
    expect(db.tabelas.calendar_clinicorp_integrations).toHaveLength(1);
    expect(db.tabelas.calendar_clinicorp_integrations![0]!.webhook_token_hash).toBe(createHash("sha256").update(segundo).digest("hex"));
    expect(vi.mocked(audit).mock.calls[1]?.[0]).toMatchObject({ metadata: { trocou_endereco: true } });
  });

  it("com a linha só de webhook, salvar a credencial ainda exige o token", async () => {
    await GERAR_WEBHOOK();
    expect((await PUT(pedir("PUT", { usuario_api: "u" }))).status).toBe(422);
    expect((await PUT(pedir("PUT", { usuario_api: "u", token_api: TOKEN }))).status).toBe(200);
    expect(db.tabelas.calendar_clinicorp_integrations![0]).toMatchObject({ api_user: "u", webhook_token_hash: expect.any(String) });
  });
});

describe("a importação do relatório exportado (0435)", () => {
  const importar = (corpo: unknown) =>
    IMPORTAR(new NextRequest("http://localhost/api/v1/agenda/clinicorp/importar", { method: "POST", body: JSON.stringify(corpo) }));
  const futuro = { dia: "2030-03-12", de: "10:00", ate: "11:30", user_id: DRA };

  beforeEach(() => {
    db.tabelas.calendar_clinicorp_integrations!.push({ organization_id: ORG, api_user: null });
    db.tabelas.organizations = [{ id: ORG, timezone: "America/Sao_Paulo" }];
    vi.mocked(db.cliente.rpc).mockResolvedValue({ data: 1, error: null } as never);
  });

  it("grava no fuso da clínica, deixa de fora o que já passou e audita só contagens", async () => {
    const res = await importar({ horarios: [futuro, { ...futuro, dia: "2020-01-02" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ recebidos: 2, gravados: 1, passados: 1 });
    expect(db.cliente.rpc).toHaveBeenCalledWith("fn_agenda_clinicorp_importar", {
      p_org: ORG,
      p_itens: [{ user_id: DRA, starts_at: "2030-03-12T13:00:00.000Z", ends_at: "2030-03-12T14:30:00.000Z" }],
    });
    const auditoria = vi.mocked(audit).mock.calls[0]?.[0];
    expect(auditoria).toMatchObject({ action: "agenda.clinicorp_importada", organizationId: ORG });
    expect(auditoria?.metadata).toEqual({ recebidos: 2, gravados: 1, passados: 1 });
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(DRA);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain("2030");
  });

  it("campo a mais (um nome de paciente) recusa o pedido inteiro, sem gravar nada", async () => {
    const res = await importar({ horarios: [{ ...futuro, paciente: "Paciente Ficticia" }] });
    expect(res.status).toBe(422);
    expect(db.cliente.rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain("Paciente Ficticia");
  });

  it("dia que não existe ou horário invertido também recusa", async () => {
    expect((await importar({ horarios: [{ ...futuro, dia: "2030-02-31" }] })).status).toBe(422);
    expect((await importar({ horarios: [{ ...futuro, de: "12:00", ate: "11:00" }] })).status).toBe(422);
    expect(db.cliente.rpc).not.toHaveBeenCalled();
  });

  it("pessoa de fora da equipe é recusada", async () => {
    expect((await importar({ horarios: [{ ...futuro, user_id: ESTRANHA }] })).status).toBe(422);
    expect(db.cliente.rpc).not.toHaveBeenCalled();
  });

  it("sem a integração da Clinicorp, pede para ligar primeiro", async () => {
    db.tabelas.calendar_clinicorp_integrations = [];
    expect((await importar({ horarios: [futuro] })).status).toBe(404);
    expect(db.cliente.rpc).not.toHaveBeenCalled();
  });
});
