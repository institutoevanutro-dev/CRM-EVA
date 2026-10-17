// @vitest-environment node
/**
 * A RECUSA DA RLS DE `crm_leads` (42501) VIRA 403, NÃO 500.
 *
 * Portado do projeto original (DeskcommCRM, PR #2556 de @webtecnica).
 *
 * Com a visibilidade "Só os seus", um Atendente que cria um negócio sem
 * responsável (ou passa o seu a um colega) é recusado pela policy de
 * `crm_leads` com SQLSTATE 42501. O handler convertia tudo em 500
 * "Erro interno. Tente de novo" — e tentar de novo nunca resolve.
 *
 * Controle: o 42501 de OUTRA origem (GRANT faltando, ou a RLS de outra tabela)
 * continua 500 com a mensagem do banco — é defeito nosso, não permissão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => null }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));

import { createLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1",
  idioma: "pt-BR",
};

type Recusa = { code: string; message: string };

const RECUSA_DA_RLS: Recusa = {
  code: "42501",
  message: 'new row violates row-level security policy for table "crm_leads"',
};

/** Supabase de mentira: lê o que a criação/edição pergunta e recusa a ESCRITA. */
function bancoQueRecusaAEscrita(recusa: Recusa) {
  const gravados: Record<string, unknown>[] = [];
  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const cadeia = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = cadeia;
    let escrevendo = false;
    q.insert = (linha: Record<string, unknown>) => {
      escrevendo = true;
      gravados.push(linha);
      return q;
    };
    q.update = (linha: Record<string, unknown>) => {
      escrevendo = true;
      gravados.push(linha);
      return q;
    };
    q.maybeSingle = async () => {
      if (escrevendo) return { data: null, error: recusa };
      if (tabela === "crm_stages") {
        return { data: { id: ETAPA, pipeline_id: FUNIL, organization_id: ORG, is_lost: false }, error: null };
      }
      if (tabela === "crm_leads") {
        return {
          data: { id: LEAD, organization_id: ORG, contact_id: null, title: "Antes", tags: [], custom_fields: {}, updated_at: "2026-10-01T12:00:00.000Z" },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    q.single = async () => (escrevendo ? { data: null, error: recusa } : { data: null, error: null });
    q.then = (ok: (v: { data: null; error: null }) => void) => ok({ data: null, error: null });
    return q;
  };
  return { cliente: { from, rpc: async () => ({ error: null }) } as never, gravados };
}

const novo = {
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  title: "Negócio novo",
  currency: "BRL",
  tags: [],
  source: "manual",
};

beforeEach(() => vi.clearAllMocks());

describe("a recusa da RLS de crm_leads (42501) vira 403, não 500", () => {
  it("no INSERT (Atendente no modo 'Só os seus', sem responsável) → 403 forbidden", async () => {
    const { cliente } = bancoQueRecusaAEscrita(RECUSA_DA_RLS);
    await expect(createLeadHandler(cliente, ctx, novo as never)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("no UPDATE (o caminho do PATCH) → 403 forbidden", async () => {
    const { cliente } = bancoQueRecusaAEscrita(RECUSA_DA_RLS);
    await expect(
      updateLeadHandler(cliente, ctx, LEAD, { title: "Outro título" } as never),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("a frase explica o porquê, em vez de \"tente de novo\"", async () => {
    const { cliente } = bancoQueRecusaAEscrita(RECUSA_DA_RLS);
    const recusa = await createLeadHandler(cliente, ctx, novo as never).catch((e: unknown) => e);
    expect((recusa as Error).message).toContain("visibilidade");
    expect((recusa as Error).message).not.toMatch(/tente de novo|Erro interno/i);
  });

  it("42501 de outra origem (GRANT faltando, RLS de outra tabela) continua 500", async () => {
    const grant = bancoQueRecusaAEscrita({ code: "42501", message: "permission denied for function fn_x" });
    await expect(createLeadHandler(grant.cliente, ctx, novo as never)).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      message: "permission denied for function fn_x",
    });
    const outra = bancoQueRecusaAEscrita({
      code: "42501",
      message: 'new row violates row-level security policy for table "crm_lead_activities"',
    });
    await expect(
      updateLeadHandler(outra.cliente, ctx, LEAD, { title: "Outro título" } as never),
    ).rejects.toMatchObject({ status: 500, code: "internal_error" });
  });
});
