/**
 * /api/v1/agenda/clinicorp — o que é DA ROTA: o token só entra (cifrado, nunca
 * volta, nunca vai à auditoria), a organização vem da sessão, a pessoa do
 * mapeamento tem de ser da equipe. Banco em memória; dados fictícios.
 */
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
