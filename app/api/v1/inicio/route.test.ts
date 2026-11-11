/**
 * GET /api/v1/inicio — quem vê o quê, e um bloco quebrado não derruba a tela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { fakeDb } from "@/lib/inicio/fake-db.test-helper";
import type * as MeuDia from "@/lib/inicio/meu-dia";

const quebra = vi.hoisted(() => ({ agenda: false }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/ai/budget/check", () => ({
  getBudgetStatus: vi.fn(async () => ({ monthly_limit_cents: 0, current_month_consumed_cents: 0 })),
}));
vi.mock("@/lib/inicio/meu-dia", async (original) => {
  const real = await original<typeof MeuDia>();
  return {
    ...real,
    agendaDeHoje: (...args: Parameters<typeof real.agendaDeHoje>) =>
      quebra.agenda
        ? Promise.reject(new Error('relation "calendar_appointments" does not exist'))
        : real.agendaDeHoje(...args),
  };
});

import { GET } from "./route";

const ORG = "org-1";

function comoPapel(role: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", timezone: null, idioma: "pt-BR" },
    org: { orgId: ORG, role },
  } as never);
}

async function chamar() {
  const res = await GET(new Request("http://localhost/api/v1/inicio"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** O dublê de tabelas não tem `rpc`: aqui ele ganha a resposta de `fn_inicio_esperando`. */
function dbCom(tabelas: Parameters<typeof fakeDb>[0] = {}) {
  const { db } = fakeDb(tabelas);
  return Object.assign(db as object, {
    rpc: async () => ({
      data: {
        ve_sem_responsavel: true,
        recentes: { total: 3, com_voce: 1, sem_responsavel: 2 },
        antigas: { total: 9, com_voce: 0, sem_responsavel: 4 },
        itens: [],
      },
      error: null,
    }),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  quebra.agenda = false;
  vi.mocked(createClient).mockResolvedValue(dbCom());
});

describe("GET /api/v1/inicio", () => {
  it.each(["viewer", "provider", "agent", "ai_operator"])("%s recebe só 'meu dia' — gestão é null, nem vazia", async (papel) => {
    comoPapel(papel);
    const d = await chamar();
    expect(d.gestao).toBeNull();
    expect(d.meuDia).toBeDefined();
  });

  it.each(["manager", "admin"])("%s recebe gestão", async (papel) => {
    comoPapel(papel);
    const d = (await chamar()) as { gestao: Record<string, { ok: boolean }> | null };
    expect(d.gestao).not.toBeNull();
    expect(d.gestao!.configuracao).toEqual({ ok: true, total: 0, grupos: [] });
    expect(d.gestao!.gastoIa).toEqual({ ok: true, consumidoCents: 0, limiteCents: null });
  });

  it("meu dia: esperando resposta soma o que é da pessoa com o que está sem responsável; avisos vêm por assunto", async () => {
    comoPapel("agent");
    const d = (await chamar()) as { meuDia: Record<string, unknown> };
    expect(d.meuDia.esperando).toEqual({
      ok: true,
      total: 3,
      comVoce: 1,
      semResponsavel: 2,
      veSemResponsavel: true,
      antigas: 4,
      itens: [],
    });
    expect(d.meuDia.avisos).toEqual({ ok: true, total: 0, grupos: [], outros: 0 });
  });

  it("um bloco que lança vira {ok:false} e os outros continuam", async () => {
    comoPapel("admin");
    quebra.agenda = true;
    const d = (await chamar()) as { meuDia: Record<string, { ok: boolean }> };
    expect(d.meuDia.agenda).toEqual({ ok: false });
    expect(d.meuDia.avisos!.ok).toBe(true);
  });

  it("fuso inválido no perfil não derruba os blocos com hora", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u1", timezone: "Nao/Existe", idioma: "pt-BR" },
      org: { orgId: ORG, role: "agent" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(
      dbCom({
        calendar_appointments: [
          { id: "h1", organization_id: ORG, owner_user_id: "u1", status: "confirmed", title: "Consulta", starts_at: new Date().toISOString() },
        ],
      }),
    );
    const d = (await chamar()) as { meuDia: Record<string, { ok: boolean }> };
    expect(d.meuDia.agenda!.ok).toBe(true);
  });

  it("preserva a negativa de autorização", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await GET(new Request("http://localhost/api/v1/inicio"));
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});
