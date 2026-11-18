/**
 * `GET /api/v1/campaigns/:id/recipients` — o filtro bate com os quadros
 * (auditoria de 17/11/2026, item 22).
 *
 * Os quadros contam por CARIMBO (quem respondeu também foi entregue); o filtro
 * contava por `status`, e "Entregues" escondia justamente quem respondeu.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { GET } = await import("./route");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ID = "cccccccc-0000-4000-8000-000000000001";
const base = { organization_id: ORG, campaign_id: ID, eligibility_status: "eligible", exclusion_reason: null };
const t0 = "2026-11-17T12:00:00.000Z";

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u", idioma: "pt-BR" } } as never);
  const banco = supabaseEmMemoria({
    campaign_recipients: [
      { ...base, id: "a", created_at: t0, status: "replied", sent_at: t0, delivered_at: t0, replied_at: t0 },
      { ...base, id: "b", created_at: t0, status: "delivered", sent_at: t0, delivered_at: t0, replied_at: null },
      { ...base, id: "c", created_at: t0, status: "sent", sent_at: t0, delivered_at: null, replied_at: null },
      { ...base, id: "d", created_at: t0, status: "pending", sent_at: null, delivered_at: null, replied_at: null },
    ],
  });
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
});

async function ids(status: string): Promise<string[]> {
  const res = await GET(new NextRequest(`http://localhost/api/v1/campaigns/${ID}/recipients?status=${status}`), {
    params: Promise.resolve({ id: ID }),
  });
  return ((await res.json()).data as Array<{ id: string }>).map((d) => d.id).sort();
}

describe("filtro de destinatários", () => {
  it("Entregues inclui quem foi além e respondeu — como o quadro", async () => {
    expect(await ids("delivered")).toEqual(["a", "b"]);
  });

  it("Enviadas inclui entregues e respondidas", async () => {
    expect(await ids("sent")).toEqual(["a", "b", "c"]);
  });

  it("os estados sem quadro continuam por status", async () => {
    expect(await ids("pending")).toEqual(["d"]);
  });
});
