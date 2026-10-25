import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { type Linha, supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

/**
 * O registro mora no item da fila de HOJE de quem pede. Item de outra pessoa ou
 * de outra organização é 404, e a organização vem da sessão, nunca do corpo.
 */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_OUTRA_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOJE = diaLocalISO(new Date(), "America/Sao_Paulo");
const RESUMO = "Pediu retorno na semana que vem";

const estado = vi.hoisted(() => ({ auditados: [] as Array<Record<string, unknown>>, atividades: [] as Array<Record<string, unknown>> }));
const banco = vi.hoisted(() => ({ atual: null as null | ReturnType<typeof supabaseEmMemoria> }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: "org-a", role: "admin" },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (e: Record<string, unknown>) => void estado.auditados.push(e) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: async (_s: unknown, e: Record<string, unknown>) => (estado.atividades.push(e), { ok: true }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.atual!.cliente }));
vi.mock("@/lib/bonus/fatos", () => ({
  lerPrograma: async (_a: unknown, org: string) =>
    org === "org-a" ? { status: "ok", programa: { organizationId: org, fuso: "America/Sao_Paulo" } } : { status: "ausente" },
}));

import { POST } from "./route";

const item = (id: string, user_id: string, organization_id = "org-a"): Linha => ({
  id,
  organization_id,
  dia: HOJE,
  tipo: "ligacao",
  user_id,
  contact_id: `c-${id}`,
  ligacao_resultado: null,
  ligacao_resumo: null,
  ligacao_registrada_em: null,
});

const post = (corpo: unknown) =>
  POST(new NextRequest("http://localhost/api/v1/bonus/ligacoes", { method: "POST", body: JSON.stringify(corpo) }));

const gravados = () => banco.atual!.tabelas.bonus_fila_itens!.filter((l) => l.ligacao_resultado !== null);

beforeEach(() => {
  estado.auditados.length = 0;
  estado.atividades.length = 0;
  banco.atual = supabaseEmMemoria({
    bonus_fila_itens: [item(ITEM_A, A), item(ITEM_B, B), item(ITEM_OUTRA_ORG, A, "org-b")],
    crm_leads: [{ id: "lead-1", organization_id: "org-a", contact_id: `c-${ITEM_A}`, updated_at: "2026-11-01T10:00:00Z" }],
  });
});

describe("POST /api/v1/bonus/ligacoes", () => {
  it("item de outra pessoa: 404, nada gravado nem auditado", async () => {
    const res = await post({ item_id: ITEM_B, resultado: "atendeu", resumo: RESUMO });
    expect(res.status).toBe(404);
    expect(gravados()).toEqual([]);
    expect(estado.auditados).toEqual([]);
    expect(estado.atividades).toEqual([]);
  });

  it("item de outra organização: 404, mesmo pondo a organização no corpo", async () => {
    const res = await post({ item_id: ITEM_OUTRA_ORG, resultado: "atendeu", resumo: RESUMO, organization_id: "org-b" });
    expect(res.status).toBe(404);
    expect(gravados()).toEqual([]);
    expect(estado.auditados).toEqual([]);
  });

  it("corpo inválido: 422", async () => {
    for (const corpo of [{ item_id: "x", resultado: "atendeu", resumo: RESUMO }, { item_id: ITEM_A, resultado: "talvez", resumo: RESUMO }, { item_id: ITEM_A, resultado: "atendeu", resumo: "ok" }, null]) {
      expect((await post(corpo)).status).toBe(422);
    }
    expect(gravados()).toEqual([]);
  });

  it("caso feliz: grava no item, audita e põe na timeline SEM o resumo", async () => {
    const res = await post({ item_id: ITEM_A, resultado: "nao_atendeu", resumo: RESUMO });
    expect(res.status).toBe(200);
    expect(gravados()).toEqual([expect.objectContaining({ id: ITEM_A, ligacao_resultado: "nao_atendeu", ligacao_resumo: RESUMO })]);
    expect(estado.auditados).toEqual([
      expect.objectContaining({ action: "bonus.ligacao_registrada", organizationId: "org-a", resourceId: ITEM_A, metadata: { resultado: "nao_atendeu" } }),
    ]);
    expect(estado.atividades).toEqual([expect.objectContaining({ type: "call_logged", leadId: "lead-1", sourceId: ITEM_A })]);
    expect(JSON.stringify([estado.auditados, estado.atividades])).not.toContain(RESUMO);
  });
});
