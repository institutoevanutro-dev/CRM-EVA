/**
 * A rota do horário de envio: quem pode salvar, em qual organização, e com qual
 * fuso. As fronteiras (sessão, banco, auditoria) são dubladas; o handler e a
 * regra `settingsComJanela` são os de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { lerConfigDosBloqueios } from "@/lib/followup/bloqueios-obrigatorios";

const auditSpy = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const updates: Array<{ linha: Record<string, unknown>; filtro: [string, unknown] }> = [];
const leituras: Array<[string, unknown]> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (c: string, v: unknown) => {
          leituras.push([c, v]);
          return {
            maybeSingle: async () => ({
              data: { settings: { routing: { mode: "manual" } }, timezone: "America/Manaus" },
              error: null,
            }),
          };
        },
      }),
      update: (linha: Record<string, unknown>) => ({
        eq: async (c: string, v: unknown) => {
          updates.push({ linha, filtro: [c, v] });
          return { error: null };
        },
      }),
    }),
  }),
}));

const { PATCH } = await import("@/app/api/v1/settings/followups/horario/route");

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/followups/horario", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const JANELA = { dias: [1, 2, 3, 4, 5], intervalos: [{ inicio: "08:00", fim: "21:00" }] };

beforeEach(() => {
  updates.length = 0;
  leituras.length = 0;
  auditSpy.mockClear();
  vi.mocked(requireRole).mockReset();
});

describe("PATCH /api/v1/settings/followups/horario", () => {
  it("quem não é gerente não salva — e o banco nem é lido", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await PATCH(pedido({ janela: JANELA }));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(leituras).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("gerente salva na PRÓPRIA organização, no fuso dela, sem apagar o resto, e audita", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u1" },
      org: { orgId: ORG, role: "manager" },
    } as never);
    const res = await PATCH(pedido({ janela: JANELA }));
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filtro).toEqual(["id", ORG]);
    expect(updates[0]!.linha.settings).toMatchObject({ routing: { mode: "manual" } });
    expect(lerConfigDosBloqueios(updates[0]!.linha.settings)?.janela).toEqual({
      timezone: "America/Manaus",
      ...JANELA,
    });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup.horario_de_envio_changed", organizationId: ORG }),
    );
  });

  it("corpo com fuso é recusado: o fuso é da organização, não de quem chama", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u1" },
      org: { orgId: ORG, role: "manager" },
    } as never);
    const res = await PATCH(pedido({ janela: { ...JANELA, timezone: "UTC" } }));
    expect(res.status).toBe(422);
    expect(updates).toEqual([]);
  });
});
