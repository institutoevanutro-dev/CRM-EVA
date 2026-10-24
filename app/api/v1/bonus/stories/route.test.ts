import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O lançamento manual é do APROVADOR (um usuário, não um papel), e a
 * organização vem da sessão, nunca do corpo.
 */

const sessao = vi.hoisted(() => ({ userId: "u-aprovador-a", orgId: "org-a" }));
const gravados = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const aprovadorPorOrg: Record<string, string> = { "org-a": "u-aprovador-a", "org-b": "u-aprovador-b" };

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: sessao.userId, idioma: "pt-BR" },
    org: { orgId: sessao.orgId, role: "admin" },
  })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/bonus/fatos", () => ({
  lerPrograma: vi.fn(async (_admin: unknown, org: string) =>
    aprovadorPorOrg[org]
      ? { status: "ok", programa: { organizationId: org, aprovadorUserId: aprovadorPorOrg[org], fuso: "America/Sao_Paulo" } }
      : { status: "ausente" },
  ),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      upsert: async (linha: Record<string, unknown>) => {
        gravados.push(linha);
        return { error: null };
      },
    }),
  })),
}));

import { lerPrograma } from "@/lib/bonus/fatos";

import { PUT } from "./route";

const put = (corpo: unknown) =>
  PUT(new NextRequest("http://localhost/api/v1/bonus/stories", { method: "PUT", body: JSON.stringify(corpo) }));

beforeEach(() => {
  gravados.length = 0;
  sessao.userId = "u-aprovador-a";
  sessao.orgId = "org-a";
  vi.mocked(lerPrograma).mockClear();
  // Hoje é 03/11/2026 no fuso do programa: o mês aberto vai de 01/11 a 03/11.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T15:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PUT /api/v1/bonus/stories", () => {
  it("o aprovador lança: 200 e grava na organização da sessão", async () => {
    const res = await put({ dia: "2026-11-03", contagem: 2 });
    expect(res.status).toBe(200);
    expect(gravados).toHaveLength(1);
    expect(gravados[0]).toMatchObject({
      organization_id: "org-a",
      dia: "2026-11-03",
      contagem_manual: 2,
      lancado_por: "u-aprovador-a",
    });
  });

  it("outro admin da MESMA organização que não é o aprovador: 403, nada gravado", async () => {
    sessao.userId = "u-outro-admin";
    const res = await put({ dia: "2026-11-03", contagem: 2 });
    expect(res.status).toBe(403);
    expect(gravados).toHaveLength(0);
  });

  it("o aprovador da org A logado na org B não grava na A, nem pondo a A no corpo", async () => {
    sessao.orgId = "org-b";
    const res = await put({ dia: "2026-11-03", contagem: 2, organization_id: "org-a" });
    expect(res.status).toBe(403);
    expect(vi.mocked(lerPrograma).mock.calls[0]![1]).toBe("org-b");
    expect(gravados).toHaveLength(0);
  });

  it("corpo inválido: 422", async () => {
    for (const corpo of [{ dia: "03/11/2026", contagem: 2 }, { dia: "2026-11-03", contagem: 51 }, { dia: "2026-11-03" }, null]) {
      expect((await put(corpo)).status).toBe(422);
    }
    expect(gravados).toHaveLength(0);
  });

  it("dia impossível, de mês fechado ou futuro: 422, nada gravado", async () => {
    for (const dia of ["2026-02-31", "2026-13-45", "2026-10-31", "2026-11-04", "2027-11-01"]) {
      expect((await put({ dia, contagem: 2 })).status, dia).toBe(422);
    }
    expect(gravados).toHaveLength(0);
  });

  it("o mês aberto é o do FUSO do programa: 00h30 UTC do dia 1 ainda é o mês anterior em São Paulo", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));
    expect((await put({ dia: "2026-11-30", contagem: 1 })).status).toBe(200);
    expect((await put({ dia: "2026-12-01", contagem: 1 })).status).toBe(422);
  });

  it("contagem null devolve o dia à leitura automática (grava null)", async () => {
    const res = await put({ dia: "2026-11-03", contagem: null });
    expect(res.status).toBe(200);
    expect(gravados[0]).toMatchObject({ organization_id: "org-a", contagem_manual: null });
  });
});
