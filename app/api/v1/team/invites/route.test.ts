import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/team/convites", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkDeAceite: (row: { id: string }) => `https://crm.exemplo.test/team/accept-invite/${row.id}`,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const base = {
  organization_id: ORG,
  email: "fulana@exemplo.test",
  role: "agent",
  interface_settings: { preset: "completa" },
  invited_by: null,
  inviter_name: null,
  email_dispatched: false,
  created_at: "2026-11-01T00:00:00Z",
  last_sent_at: "2026-11-01T00:00:00Z",
  resend_count: 0,
  accepted_at: null,
  revoked_at: null,
};

/** Auditoria 17/11, item 170: convite vencido oferecia "Copiar link" de um link morto. */
describe("GET /api/v1/team/invites — link de aceite", () => {
  it("só o pendente leva link; vencido não", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    } as never);
    const rows = [
      { ...base, id: "pendente", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      { ...base, id: "vencido", expires_at: new Date(Date.now() - 3600_000).toISOString() },
    ];
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({
        select: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }) }),
      }),
    } as never);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/team/invites"));
    const body = (await res.json()) as { data: Array<{ id: string; status: string; accept_url: string | null }> };
    const porId = Object.fromEntries(body.data.map((c) => [c.id, c]));

    expect(porId.pendente?.status).toBe("pendente");
    expect(porId.pendente?.accept_url).toContain("/team/accept-invite/pendente");
    expect(porId.vencido?.status).toBe("expirado");
    expect(porId.vencido?.accept_url).toBeNull();
  });
});
