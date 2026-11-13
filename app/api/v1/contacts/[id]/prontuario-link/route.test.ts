import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { validateBearerToken } from "@/lib/mcp/auth";
import type * as McpAuth from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (orig) => ({
  ...(await orig<typeof McpAuth>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "44444444-4444-4444-8444-444444444444";
const contato = "22222222-2222-4222-8222-222222222222";
const paciente = "33333333-3333-4333-8333-333333333333";
const token = "55555555-5555-4555-8555-555555555555";

let links: Record<string, unknown>[];

const ctx = (id = contato) => ({ params: Promise.resolve({ id }) });
const req = (bearer?: string) =>
  new NextRequest("http://localhost/x", {
    method: "DELETE",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
const sessao = (orgId: string, role = "manager") =>
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId, role },
  } as Awaited<ReturnType<typeof requireRole>>);

beforeEach(() => {
  vi.clearAllMocks();
  links = [{ id: "l1", organization_id: orgA, contact_id: contato, source_patient_id: paciente, linked_by_api_token_id: token }];
  sessao(orgA);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      expect(tabela).toBe("prontuario_contact_links");
      const f: Record<string, unknown> = {};
      const q = {
        delete: () => q,
        eq: (k: string, v: unknown) => {
          f[k] = v;
          return q;
        },
        select: async () => {
          const casam = links.filter((l) => Object.entries(f).every(([k, v]) => l[k] === v));
          links = links.filter((l) => !casam.includes(l));
          return { data: casam, error: null };
        },
      };
      return q;
    },
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("DELETE /api/v1/contacts/[id]/prontuario-link", () => {
  it("gestor desvincula: apaga a linha e audita com a cópia dela", async () => {
    const r = await DELETE(req(), ctx());
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect((await r.json()).data).toEqual({ contact_id: contato, source_patient_id: paciente, unlinked: true });
    expect(links).toHaveLength(0);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prontuario.contact_unlinked",
        actorUserId: "u1",
        actorApiTokenId: null,
        organizationId: orgA,
        resourceId: contato,
        metadata: expect.objectContaining({
          via: "session",
          vinculo_removido: expect.objectContaining({ id: "l1", source_patient_id: paciente }),
        }),
      }),
    );
  });

  it("isolamento: sessão de outra organização não alcança o vínculo (404, linha intacta)", async () => {
    sessao(orgB);
    const r = await DELETE(req(), ctx());
    expect(r.status).toBe(404);
    expect(links).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("papel insuficiente recusa sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "x", 403) });
    expect((await DELETE(req(), ctx())).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem vínculo: 404 e nada auditado", async () => {
    links = [];
    const r = await DELETE(req(), ctx());
    expect(r.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("id inválido: 422", async () => {
    expect((await DELETE(req(), ctx("nao-e-uuid"))).status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("Bearer com prontuario:contacts:write desvincula na organização do TOKEN", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: orgA,
      role: "agent",
      scopes: ["prontuario:contacts:write"],
      actor: { type: "api_token", id: token, role: "agent" },
    } as unknown as Awaited<ReturnType<typeof validateBearerToken>>);
    const r = await DELETE(req("dsk_x"), ctx());
    expect(r.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: token, metadata: expect.objectContaining({ via: "token" }) }),
    );
  });

  it("Bearer de outra organização não alcança o vínculo", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: orgB,
      role: "agent",
      scopes: ["prontuario:contacts:write"],
      actor: { type: "api_token", id: token, role: "agent" },
    } as unknown as Awaited<ReturnType<typeof validateBearerToken>>);
    expect((await DELETE(req("dsk_x"), ctx())).status).toBe(404);
    expect(links).toHaveLength(1);
  });

  it("Bearer sem o escopo de escrita do Prontuário recusa (403)", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: orgA,
      role: "admin",
      scopes: ["prontuario:contacts:read", "mcp:write", "role:admin"],
      actor: { type: "api_token", id: token, role: "admin" },
    } as unknown as Awaited<ReturnType<typeof validateBearerToken>>);
    expect((await DELETE(req("dsk_x"), ctx())).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
