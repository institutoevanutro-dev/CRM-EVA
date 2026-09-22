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

beforeEach(() => {
  vi.clearAllMocks();
  quebra.agenda = false;
  vi.mocked(createClient).mockResolvedValue(fakeDb({}).db as never);
});

describe("GET /api/v1/inicio", () => {
  it("colaborador recebe só 'meu dia' — gestão é null, nem vazia", async () => {
    comoPapel("agent");
    const d = await chamar();
    expect(d.gestao).toBeNull();
    expect(d.meuDia).toBeDefined();
  });

  it("gerente recebe gestão", async () => {
    comoPapel("manager");
    const d = (await chamar()) as { gestao: Record<string, { ok: boolean }> | null };
    expect(d.gestao).not.toBeNull();
    expect(d.gestao!.configuracao!.ok).toBe(true);
    expect(d.gestao!.gastoIa).toEqual({ ok: true, consumidoCents: 0, limiteCents: null });
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
      fakeDb({
        calendar_appointments: [
          { id: "h1", organization_id: ORG, owner_user_id: "u1", status: "confirmed", title: "Consulta", starts_at: new Date().toISOString() },
        ],
      }).db as never,
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
