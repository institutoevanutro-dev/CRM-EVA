/**
 * Dois furos de organização em rotas de lead (achados do coordenador da
 * auditoria de 2026-09-29):
 *
 * 1. `POST /leads/bulk` (move) lia a etapa de destino sem filtrar organização
 *    nem funil, e `fn_mover_leads_em_lote` (INVOKER) gravava `stage_id` como
 *    veio — lead ia para etapa de OUTRO funil (ou org), furando o
 *    `pipeline_immutable_use_clone` que a rota de move individual impõe.
 * 2. `POST /leads/[id]/next-action` buscava o lead só pela RLS e escrevia com
 *    `row.organization_id`: quem é agent em A e viewer em B mutava B.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "r"),
}));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { RECUSA_DE_TROCA_DE_FUNIL } from "@/lib/leads/clonar-para-funil";
import { POST as lote } from "@/app/api/v1/leads/bulk/route";
import { POST as proximaAcao } from "@/app/api/v1/leads/[id]/next-action/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const FUNIL = "55555555-5555-4555-8555-555555555555";
const OUTRO_FUNIL = "66666666-6666-4666-8666-666666666666";
const LEAD = "44444444-4444-4444-8444-444444444444";
const ETAPA_OUTRO_FUNIL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETAPA_OUTRA_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTATO = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown>;

function fakeDb(tabelas: Record<string, Linha[]>) {
  const escritas: Array<{ tabela: string; filtros: Linha }> = [];
  let rpcs = 0;
  return {
    escritas,
    get rpcs() {
      return rpcs;
    },
    from(t: string) {
      const filtros: Linha = {};
      let escrita = false;
      const linhas = () =>
        (tabelas[t] ?? []).filter((r) =>
          Object.entries(filtros).every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)),
        );
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => ((filtros[c] = v), b),
        in: (c: string, v: unknown[]) => ((filtros[c] = v), b),
        is: () => b,
        update: () => ((escrita = true), b),
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          if (escrita) escritas.push({ tabela: t, filtros });
          return Promise.resolve({ data: escrita ? null : linhas(), error: null }).then(ok, ko);
        },
      };
      return b;
    },
    rpc: async () => {
      rpcs++;
      return { data: [], error: null };
    },
  };
}

const BANCO = () => ({
  crm_leads: [
    {
      id: LEAD,
      organization_id: ORG,
      pipeline_id: FUNIL,
      stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tags: [],
      contact_id: CONTATO,
      lost_reason: null,
      status: "open",
    },
  ],
  crm_stages: [
    { id: ETAPA_OUTRO_FUNIL, organization_id: ORG, pipeline_id: OUTRO_FUNIL, name: "X", is_lost: false },
    { id: ETAPA_OUTRA_ORG, organization_id: OUTRA, pipeline_id: FUNIL, name: "Y", is_lost: false },
  ],
  lead_state: [
    { organization_id: ORG, contact_id: CONTATO, next_action: "ligar", next_action_seq: 1 },
    { organization_id: OUTRA, contact_id: CONTATO, next_action: "ligar", next_action_seq: 1 },
  ],
});

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
});

function pedidoDeLote(stageId: string) {
  return new NextRequest("http://x/api/v1/leads/bulk", {
    method: "POST",
    body: JSON.stringify({ action: "move", lead_ids: [LEAD], params: { stage_id: stageId } }),
  });
}

describe("lote: mover", () => {
  it("etapa de outro funil é recusada como na rota individual", async () => {
    const db = fakeDb(BANCO());
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await lote(pedidoDeLote(ETAPA_OUTRO_FUNIL));
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("pipeline_immutable_use_clone");
    expect(corpo.error.message).toBe(RECUSA_DE_TROCA_DE_FUNIL);
    expect(db.rpcs).toBe(0);
  });

  it("etapa de outra organização não é encontrada", async () => {
    const db = fakeDb(BANCO());
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await lote(pedidoDeLote(ETAPA_OUTRA_ORG));
    expect(res.status).toBe(404);
    expect(db.rpcs).toBe(0);
  });
});

describe("próxima ação", () => {
  it("lead fora da organização ativa é 404, e nada é escrito", async () => {
    const banco = BANCO();
    banco.crm_leads[0]!.organization_id = OUTRA;
    const db = fakeDb(banco);
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await proximaAcao(
      new NextRequest(`http://x/api/v1/leads/${LEAD}/next-action`, {
        method: "POST",
        body: JSON.stringify({ decision: "dismiss", approved_seq: 1 }),
      }),
      { params: Promise.resolve({ id: LEAD }) },
    );
    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
  });

  it("na organização ativa, escreve com a org da sessão", async () => {
    const db = fakeDb(BANCO());
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await proximaAcao(
      new NextRequest(`http://x/api/v1/leads/${LEAD}/next-action`, {
        method: "POST",
        body: JSON.stringify({ decision: "dismiss", approved_seq: 1 }),
      }),
      { params: Promise.resolve({ id: LEAD }) },
    );
    expect(res.status).toBe(200);
    expect(db.escritas).toEqual([{ tabela: "lead_state", filtros: { organization_id: ORG, contact_id: CONTATO } }]);
  });
});
