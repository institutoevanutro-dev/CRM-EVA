/**
 * B1 (auditoria 2026-09-29) — qualquer membro pegava o QR de pareamento do
 * WhatsApp. Escanear o QR liga um aparelho ao número da empresa: é o mesmo ato
 * de conectar/reconectar, que já exige admin.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as qrDoOnboarding } from "@/app/api/v1/onboarding/whatsapp/qr/route";
import { GET as qrDoCanal } from "@/app/api/v1/channel-sessions/[id]/qr/route";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org1", name: "Org", role: "viewer" })),
}));
vi.mock("@/lib/channels/onboarding-session", () => ({
  loadOnboardingChannel: vi.fn(async () => ({ waha_session_name: "default", archived_at: null })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { waha_session_name: "default", archived_at: null }, error: null }),
      };
      return q;
    },
  })),
}));

const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WAHA_API_BASE_URL", "http://waha:3000");
  vi.stubEnv("WAHA_API_KEY", "segredo");
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: NextResponse.json({ error: { code: "forbidden_role", message: "no" } }, { status: 403 }),
  });
});

describe("QR de pareamento só para admin", () => {
  it("onboarding: não-admin leva 403 e o WAHA nem é chamado", async () => {
    const r = await qrDoOnboarding();
    expect(r.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("canal: não-admin leva 403 e o WAHA nem é chamado", async () => {
    const r = await qrDoCanal(new Request("http://x"), { params: Promise.resolve({ id: "s1" }) });
    expect(r.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admin recebe a imagem", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { id: "u1" } as any,
      org: { orgId: "org1", name: "Org", role: "admin" },
    });
    expect((await qrDoOnboarding()).status).toBe(200);
    expect((await qrDoCanal(new Request("http://x"), { params: Promise.resolve({ id: "s1" }) })).status).toBe(200);
  });
});
