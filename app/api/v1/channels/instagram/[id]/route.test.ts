import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { arquivarConexaoDoInstagram, definirOrigemPadrao } from "@/lib/channels/instagram/conexao";
import { CHANNEL_CAPABILITIES } from "@/lib/channels/capabilities";
import { DELETE, PATCH } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/instagram/conexao", () => ({
  arquivarConexaoDoInstagram: vi.fn(),
  definirOrigemPadrao: vi.fn(),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = (method: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/v1/channels/instagram/${ID}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify({ ...(body as object), organization_id: "ORG-DO-CORPO" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "U1" }, org: { orgId: ORG, role: "manager" } } as Awaited<ReturnType<typeof requireRole>>);
});

describe("rota da conta do Instagram", () => {
  it("exige manager e não toca no banco quando negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(403);
    expect((await PATCH(req("PATCH", { origem_padrao: null }), ctx)).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(arquivarConexaoDoInstagram).not.toHaveBeenCalled();
    expect(definirOrigemPadrao).not.toHaveBeenCalled();
  });

  it("DELETE arquiva com a org da SESSÃO e audita só o username", async () => {
    vi.mocked(arquivarConexaoDoInstagram).mockResolvedValue({ username: "clinica" });
    const r = await DELETE(req("DELETE"), ctx);
    expect(r.status).toBe(200);
    expect(arquivarConexaoDoInstagram).toHaveBeenCalledWith(expect.anything(), ORG, ID);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.instagram_disconnected", organizationId: ORG, metadata: { username: "clinica" } }));
    const corpo = JSON.stringify(await r.json());
    for (const p of Object.keys(CHANNEL_CAPABILITIES)) expect(corpo).not.toContain(p);
  });

  it("DELETE de conta de outra org (ou já arquivada) é 404 e não audita", async () => {
    vi.mocked(arquivarConexaoDoInstagram).mockResolvedValue(null);
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("PATCH grava a origem com a org da sessão, ignorando organization_id do corpo", async () => {
    vi.mocked(definirOrigemPadrao).mockResolvedValue(true);
    const r = await PATCH(req("PATCH", { origem_padrao: { campo: "origem", valor: "instagram" } }), ctx);
    expect(r.status).toBe(200);
    expect(definirOrigemPadrao).toHaveBeenCalledWith(expect.anything(), ORG, ID, { campo: "origem", valor: "instagram" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.instagram_origem_changed", organizationId: ORG }));
    const corpo = JSON.stringify(await r.json());
    for (const p of Object.keys(CHANNEL_CAPABILITIES)) expect(corpo).not.toContain(p);
  });

  it("PATCH com null limpa; corpo inválido é 422", async () => {
    vi.mocked(definirOrigemPadrao).mockResolvedValue(true);
    expect((await PATCH(req("PATCH", { origem_padrao: null }), ctx)).status).toBe(200);
    expect(definirOrigemPadrao).toHaveBeenCalledWith(expect.anything(), ORG, ID, null);
    expect((await PATCH(req("PATCH", { origem_padrao: { campo: "1 ruim", valor: "" } }), ctx)).status).toBe(422);
  });
});
