/**
 * Perdido em lote (portes do upstream #2868 e #2922, issue #2887).
 *
 * Contra o Route Handler REAL de `POST /api/v1/leads/bulk` (auth e Supabase
 * mockados), prende:
 *  1. quem JÁ estava perdido não tem o motivo trocado: ele vai numa chamada de
 *     `fn_mover_leads_em_lote` SEM motivo (a coluna fica fora da escrita), e os
 *     demais na chamada com o motivo do lote;
 *  2. a timeline de quem é perdido AGORA diz "Perdido — <motivo>", a mesma
 *     frase da `/lose`; a de quem já estava perdido conta só a transição;
 *  3. auditoria `lead.lost` por lead perdido agora, com o motivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type AuthUser, type Role } from "@/lib/auth/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "Movido de X para Perdido"),
}));

import { POST } from "@/app/api/v1/leads/bulk/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const PERDIDO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEGOCIANDO_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CARD_ABERTO = "44444444-4444-4444-8444-444444444444";
const CARD_JA_PERDIDO = "66666666-6666-4666-8666-666666666666";

const leads = [
  { id: CARD_ABERTO, organization_id: ORG_ID, tags: [], stage_id: NEGOCIANDO_ID, pipeline_id: PIPELINE_ID, contact_id: null, lost_reason: null, status: "open" },
  { id: CARD_JA_PERDIDO, organization_id: ORG_ID, tags: [], stage_id: PERDIDO_ID, pipeline_id: PIPELINE_ID, contact_id: null, lost_reason: "price", status: "lost" },
];

let chamadas: Array<{ p_lead_ids: string[]; p_lost_reason: string | null }>;

function clienteStub() {
  return {
    from: () => {
      const b = {
        select: () => b,
        update: () => b,
        eq: () => b,
        in: () => b,
        is: () => b,
        maybeSingle: () =>
          Promise.resolve({
            data: { id: PERDIDO_ID, name: "Perdido", is_lost: true, pipeline_id: PIPELINE_ID },
            error: null,
          }),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve({ data: leads, error: null }).then(onF, onR),
      };
      return b;
    },
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== "fn_mover_leads_em_lote") return Promise.resolve({ data: null, error: null });
      const ids = args.p_lead_ids as string[];
      chamadas.push({ p_lead_ids: ids, p_lost_reason: (args.p_lost_reason as string | null) ?? null });
      return Promise.resolve({
        data: ids.map((id) => ({
          lead_id: id,
          from_stage_id: leads.find((l) => l.id === id)!.stage_id === PERDIDO_ID ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : NEGOCIANDO_ID,
          pipeline_id: PIPELINE_ID,
        })),
        error: null,
      });
    },
  };
}

function adminStub() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
  };
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) };
}

beforeEach(() => {
  chamadas = [];
  vi.clearAllMocks();
  const user = {
    id: USER_ID,
    email: "m@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" as Role }],
  } as AuthUser;
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" as Role },
  }) as never);
  vi.mocked(createClient).mockResolvedValue(clienteStub() as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
});

function pedido() {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "move",
      lead_ids: [CARD_ABERTO, CARD_JA_PERDIDO],
      params: { stage_id: PERDIDO_ID, lost_reason: "no_response" },
    }),
  });
}

describe("perdido em lote", () => {
  it("quem já estava perdido é movido SEM motivo; o motivo do lote vai só para os novos", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    expect(chamadas).toEqual([
      { p_lead_ids: [CARD_JA_PERDIDO], p_lost_reason: null },
      { p_lead_ids: [CARD_ABERTO], p_lost_reason: "no_response" },
    ]);
  });

  it("timeline e auditoria de perda só para quem foi perdido AGORA", async () => {
    await POST(pedido());
    const razoes = new Map(
      vi.mocked(emitLeadActivity).mock.calls.map(([, a]) => [a.leadId, a.reason]),
    );
    expect(razoes.get(CARD_ABERTO)).toBe("Perdido — no_response");
    expect(razoes.get(CARD_JA_PERDIDO)).toBe("Movido de X para Perdido");

    const perdas = vi.mocked(audit).mock.calls.filter(([e]) => e.action === "lead.lost");
    expect(perdas.map(([e]) => e.resourceId)).toEqual([CARD_ABERTO]);
    expect(perdas[0]?.[0].metadata).toMatchObject({ lost_reason: "no_response" });
  });
});
