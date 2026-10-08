/**
 * O PRESTADOR PUBLICA JORNADA, MAS NÃO ROTEIA.
 *
 * Medido em produção (05/10/2026): um `provider` aceito não aparecia em Equipe ›
 * Atendimento — a única porta da tela para gravar `attendant_availability.schedule`,
 * que a Agenda lê para oferecer horário. O filtro agent+ do roster é certo para
 * ROTEAMENTO e escalação, e errado para a jornada de agenda. As duas perguntas
 * agora são separadas: a tela pede prestadores explicitamente; quem decide
 * "quem pode assumir uma conversa" segue sem eles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { carregarRosterDeAtendimento } from "@/lib/escalacao/atendentes";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  isServiceRoleConfigured: vi.fn(() => true),
  audit: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const GERENTE = "11111111-1111-4111-8111-111111111111";
const ANA = "33333333-3333-4333-8333-333333333333";
const LEO = "44444444-4444-4444-8444-444444444444";
const UNIDADE = "55555555-5555-4555-8555-555555555555";

const MEMBROS = [
  { user_id: GERENTE, role: "manager" },
  { user_id: ANA, role: "agent" },
  { user_id: LEO, role: "provider" },
  { user_id: "66666666-6666-4666-8666-666666666666", role: "viewer" },
];

function sessao(papel: Role) {
  const user: AuthUser = {
    id: GERENTE,
    email: "g@example.com",
    full_name: "Gerente",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

/** Dublê por tabela; registra os filtros para provar o recorte de papel. */
function dubleDb(porTabela: Record<string, unknown>) {
  const filtros: Array<[string, string, unknown]> = [];
  const upserts: unknown[] = [];
  const from = (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (k: string, v: unknown) => (filtros.push([tabela, k, v]), q),
      is: (k: string, v: unknown) => (filtros.push([tabela, k, v]), q),
      in: (k: string, v: unknown) => (filtros.push([tabela, k, v]), q),
      upsert: (linha: unknown) => (upserts.push(linha), q),
      maybeSingle: () => Promise.resolve({ data: porTabela[tabela] ?? null, error: null }),
      single: () => Promise.resolve({ data: upserts.at(-1) ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: porTabela[tabela] ?? [], error: null }).then(res),
    };
    return q;
  };
  const db = {
    from,
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({ data: { user: { id, email: `${id.slice(0, 4)}@x.com`, user_metadata: {} } } }),
      },
    },
  };
  return { db, filtros, upserts };
}

beforeEach(() => vi.clearAllMocks());

describe("roster: jornada de agenda x roteamento", () => {
  it("o padrão (escalação/capacidade do agente) segue sem prestador", async () => {
    const { db } = dubleDb({ user_organizations: MEMBROS });
    const roster = await carregarRosterDeAtendimento(db as unknown as SupabaseClient, ORG);
    expect(roster.map((r) => r.userId).sort()).toEqual([ANA, GERENTE].sort());
  });

  it("a tela de jornada pede o prestador explicitamente", async () => {
    const { db } = dubleDb({ user_organizations: MEMBROS });
    const roster = await carregarRosterDeAtendimento(db as unknown as SupabaseClient, ORG, {
      incluirPrestadores: true,
    });
    expect(roster.map((r) => r.userId).sort()).toEqual([ANA, GERENTE, LEO].sort());
  });

  it("loadEligibleAttendants recorta papel no banco, sem provider", async () => {
    const { db, filtros } = dubleDb({ user_organizations: [], attendant_availability: [] });
    await loadEligibleAttendants(db as unknown as SupabaseClient, ORG, new Date(), {
      kind: "organization_summary",
    });
    const papeis = filtros.find(([t, k]) => t === "user_organizations" && k === "role")?.[2];
    expect(papeis).toEqual(["agent", "manager", "admin"]);
  });
});

describe("GET /api/v1/attendants/availability", () => {
  it("lista o prestador com o papel, para a tela tratá-lo como só agenda", async () => {
    sessao("manager");
    const { db } = dubleDb({ user_organizations: MEMBROS });
    vi.mocked(createAdminClient).mockReturnValue(db as unknown as ReturnType<typeof createAdminClient>);
    const { GET } = await import("@/app/api/v1/attendants/availability/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/attendants/availability"));
    const body = (await res.json()) as { data: Array<{ user_id: string; role: string }> };
    expect(body.data.find((r) => r.user_id === LEO)?.role).toBe("provider");
    expect(body.data).toHaveLength(3);
  });
});

describe("PATCH /api/v1/attendants/availability/{user_id} num prestador", () => {
  async function patch(corpo: unknown) {
    sessao("manager");
    const duble = dubleDb({ user_organizations: { user_id: LEO, role: "provider" } });
    vi.mocked(createClient).mockResolvedValue(duble.db as unknown as Awaited<ReturnType<typeof createClient>>);
    const { PATCH } = await import("@/app/api/v1/attendants/availability/[user_id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/attendants/availability/${LEO}`, {
        method: "PATCH",
        body: JSON.stringify(corpo),
      }),
      { params: Promise.resolve({ user_id: LEO }) },
    );
    return { res, upserts: duble.upserts };
  }

  it("grava janelas com unidade", async () => {
    const schedule = {
      timezone: "America/Sao_Paulo",
      windows: [{ dow: 1, start: "08:00", end: "12:00", unit_id: UNIDADE }],
    };
    const { res, upserts } = await patch({ schedule });
    expect(res.status).toBe(200);
    expect(upserts[0]).toMatchObject({ user_id: LEO, schedule });
  });

  it("recusa ligar o plantão: prestador não entra no roteamento", async () => {
    const { res, upserts } = await patch({ is_available: true });
    expect(res.status).toBe(422);
    expect(upserts).toHaveLength(0);
  });
});
