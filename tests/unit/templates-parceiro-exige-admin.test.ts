/**
 * M7 (auditoria 2026-09-29) — qualquer membro, até viewer, criava modelo de
 * mensagem na conta do WhatsApp pela rota do canal intermediado, e o corpo não
 * passava por Zod. Criar/sincronizar é de admin, como na rota do canal oficial.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/v1/channels/partner/templates/route";
import { requireRole } from "@/lib/auth/require-role";

const create = vi.fn(async () => undefined);
const list = vi.fn(async () => []);

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org1", name: "Org", role: "viewer" })),
}));
vi.mock("@/lib/channels/connect", () => ({
  findPartnerSession: vi.fn(async () => ({ id: "s1", archivedAt: null })),
}));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider",
  DEFAULT_CHANNEL_PROVIDER: "waha",
  resolveSessionRef: () => "acc1",
  getAdapter: () => ({ templates: { create, list } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { id: "s1", provider: "zernio" }, error: null }),
        upsert: async () => ({ error: null }),
      };
      return q;
    },
  })),
}));

function pedido(corpo: unknown) {
  return new Request("http://x/api/v1/channels/partner/templates", {
    method: "POST",
    body: JSON.stringify(corpo),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const CRIAR = { acao: "criar", name: "boas_vindas", language: "pt_BR", components: [{ type: "BODY", text: "Oi" }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: { id: "u1", idioma: "pt-BR" } as any,
    org: { orgId: "org1", name: "Org", role: "admin" },
  });
});

describe("POST /api/v1/channels/partner/templates", () => {
  it("exige admin — viewer não cria nada na conta do WhatsApp", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden_role", message: "no" } }, { status: 403 }),
    });
    const r = await POST(pedido(CRIAR));
    expect(r.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("recusa corpo fora do schema (categoria inventada)", async () => {
    const r = await POST(pedido({ ...CRIAR, category: "QUALQUER" }));
    expect(r.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([{ acao: "sincronizar" }, {}])("admin sincroniza (%o)", async (corpo) => {
    const r = await POST(pedido(corpo));
    expect(r.status).toBe(200);
    expect(list).toHaveBeenCalled();
  });

  it("admin cria e sincroniza", async () => {
    const r = await POST(pedido(CRIAR));
    expect(r.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
