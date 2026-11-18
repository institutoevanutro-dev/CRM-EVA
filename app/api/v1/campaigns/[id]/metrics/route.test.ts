/**
 * `GET /api/v1/campaigns/:id/metrics` — os números CONTADOS no banco
 * (auditoria de 17/11/2026, item 19).
 *
 * A rota baixava as linhas com `.limit(20000)`, mas o PostgREST corta toda
 * resposta em `max_rows` (1.000 no Supabase) sem avisar: numa campanha de 1.500,
 * enviadas/entregues/responderam e o progresso paravam em 1.000. O dublê aqui
 * corta igual (`maxRows: 1000`) — só a contagem `head` é exata, como no banco.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { supabaseEmMemoria, type Linha } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { GET } = await import("./route");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ID = "cccccccc-0000-4000-8000-000000000001";

function linhas(n: number, dados: Linha): Linha[] {
  return Array.from({ length: n }, () => ({ organization_id: ORG, campaign_id: ID, eligibility_status: "eligible", ...dados }));
}

const ENVIADA = { sent_at: "2026-11-17T12:00:00.000Z" };
const ENTREGUE = { ...ENVIADA, delivered_at: "2026-11-17T12:00:05.000Z" };

const pedir = () =>
  GET(new NextRequest(`http://localhost/api/v1/campaigns/${ID}/metrics`), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: "u", idioma: "pt-BR" },
  } as never);
});

describe("métricas de campanha acima de 1.000 pessoas", () => {
  it("conta tudo, mesmo com o PostgREST cortando a resposta em 1.000 linhas", async () => {
    const banco = supabaseEmMemoria(
      {
        campaigns: [{ id: ID, organization_id: ORG }],
        campaign_recipients: [
          ...linhas(300, { status: "replied", ...ENTREGUE, replied_at: "2026-11-17T13:00:00.000Z" }),
          ...linhas(800, { status: "delivered", ...ENTREGUE }),
          ...linhas(100, { status: "sent", ...ENVIADA }),
          ...linhas(300, { status: "pending" }),
        ],
      },
      { maxRows: 1000 },
    );
    vi.mocked(createClient).mockResolvedValue(banco.cliente as never);

    const corpo = (await (await pedir()).json()).data;

    expect(corpo.contagem).toMatchObject({
      total: 1500,
      elegiveis: 1500,
      enviados: 1200,
      entregues: 1100,
      responderam: 300,
      pendentes: 300,
    });
    expect(corpo.progresso).toBeCloseTo(0.8);
  });

  it("campanha de outra organização responde 404, não zeros", async () => {
    const banco = supabaseEmMemoria({ campaigns: [{ id: ID, organization_id: "outra" }], campaign_recipients: [] });
    vi.mocked(createClient).mockResolvedValue(banco.cliente as never);

    expect((await pedir()).status).toBe(404);
  });
});
