/**
 * A rota que grava a pausa da IA por resposta humana: quem pode salvar, em qual
 * organização, o que é recusado e o que fica na auditoria. Sessão, banco e
 * auditoria são dublados; o handler e a regra de escrita são os de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { lerPausaPorRespostaHumanaMin } from "@/lib/escalacao/pausa-por-resposta-humana";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";

const auditSpy = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const updates: Array<{ linha: Record<string, unknown>; filtro: [string, unknown] }> = [];
const leituras: Array<[string, unknown]> = [];
const banco: { linha: unknown } = { linha: null };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (c: string, v: unknown) => {
          leituras.push([c, v]);
          return { maybeSingle: async () => ({ data: banco.linha, error: null }) };
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

const { PATCH } = await import("@/app/api/v1/settings/atendimento/pausa-da-ia/route");

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/atendimento/pausa-da-ia", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const comoGerente = () =>
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" },
    org: { orgId: ORG, role: "manager" },
  } as never);

beforeEach(() => {
  updates.length = 0;
  leituras.length = 0;
  banco.linha = { settings: { routing: { mode: "manual" }, atendimento: { outra: 1 } } };
  auditSpy.mockClear();
  vi.mocked(requireRole).mockReset();
});

describe("PATCH /api/v1/settings/atendimento/pausa-da-ia", () => {
  it("quem não é gerente não salva, e o banco nem é lido", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await PATCH(pedido({ minutos: 120 }));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(leituras).toEqual([]);
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("gerente salva na PRÓPRIA organização, sem apagar o resto, e audita de/para", async () => {
    comoGerente();
    const res = await PATCH(pedido({ minutos: 120 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ minutos: 120 });
    expect(leituras).toEqual([["id", ORG]]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filtro).toEqual(["id", ORG]);
    expect(updates[0]!.linha.settings).toEqual({
      routing: { mode: "manual" },
      atendimento: { outra: 1, pausa_ia_resposta_humana_min: 120 },
    });
    expect(lerPausaPorRespostaHumanaMin(updates[0]!.linha.settings)).toBe(120);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "atendimento.pausa_da_ia_changed",
        organizationId: ORG,
        actorUserId: "u1",
        metadata: { de_min: 5, para_min: 120 },
      }),
    );
    expect(AUDIT_ACTIONS as readonly string[]).toContain("atendimento.pausa_da_ia_changed");
  });

  it.each([
    ["abaixo de 5 minutos", { minutos: 4 }],
    ["acima de 24 horas", { minutos: 1441 }],
    ["fração", { minutos: 7.5 }],
    ["texto", { minutos: "120" }],
    ["sem o campo", {}],
    ["organização no corpo", { minutos: 60, organization_id: "outra" }],
  ])("recusa %s com 422, sem gravar nem auditar", async (_nome, corpo) => {
    comoGerente();
    const res = await PATCH(pedido(corpo));
    expect(res.status).toBe(422);
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("mesmo valor que já vale: responde ok, não grava nem audita", async () => {
    comoGerente();
    banco.linha = { settings: { atendimento: { pausa_ia_resposta_humana_min: 120 } } };
    const res = await PATCH(pedido({ minutos: 120 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ minutos: 120 });
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("aceita as duas pontas da faixa", async () => {
    comoGerente();
    banco.linha = { settings: { atendimento: { pausa_ia_resposta_humana_min: 60 } } };
    expect((await PATCH(pedido({ minutos: 5 }))).status).toBe(200);
    expect((await PATCH(pedido({ minutos: 1440 }))).status).toBe(200);
    expect(updates).toHaveLength(2);
  });

  it("organização não encontrada: 500, e nada é gravado por cima", async () => {
    comoGerente();
    banco.linha = null;
    const res = await PATCH(pedido({ minutos: 60 }));
    expect(res.status).toBe(500);
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
