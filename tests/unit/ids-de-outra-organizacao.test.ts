/**
 * B4 — id estrangeiro vindo do corpo não pode ser gravado na organização.
 *
 * A FK confere que o id EXISTE, não que é da MESMA organização — e o service
 * role não tem RLS para segurar. Os efeitos medidos na auditoria: a linha da
 * org A prende a credencial/contato da org B (`on delete restrict`) e o par
 * 201/404 revela se um uuid existe em outro tenant.
 *
 * Vermelho sem o fix: cada caso abaixo gravava (ou chegava ao INSERT).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: vi.fn(async () => undefined) }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { idsForaDaOrg } from "@/lib/tenancy/pertence-a-org";
import { validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { POST as criarTarefa } from "@/app/api/v1/tasks/route";
import { PUT as gravarMembros } from "@/app/api/v1/ai/routers/[id]/members/route";
import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const ALHEIO = "aaaaaaaa-0000-4000-8000-00000000000b";
const MEU = "aaaaaaaa-0000-4000-8000-00000000000a";

type Linha = Record<string, unknown>;

/** Banco de mentira que filtra de verdade por `eq`/`in`/`is`/`neq`. */
function fakeDb(tabelas: Record<string, Linha[]>) {
  const inserts: Record<string, unknown[]> = {};
  const db = {
    inserts,
    from(t: string) {
      const filtros: Array<(r: Linha) => boolean> = [];
      let op: "select" | "insert" | "delete" = "select";
      let payload: unknown = null;
      const linhas = () => (tabelas[t] ?? []).filter((r) => filtros.every((f) => f(r)));
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        limit: () => b,
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), b),
        neq: (c: string, v: unknown) => (filtros.push((r) => r[c] !== v), b),
        is: (c: string, v: unknown) => (filtros.push((r) => (r[c] ?? null) === v), b),
        in: (c: string, vs: unknown[]) => (filtros.push((r) => vs.includes(r[c])), b),
        delete: () => ((op = "delete"), b),
        insert: (p: unknown) => {
          op = "insert";
          payload = p;
          (inserts[t] ??= []).push(p);
          return b;
        },
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        single: async () => ({ data: op === "insert" ? { id: "novo", ...(payload as Linha) } : linhas()[0], error: null }),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve(op === "select" ? { data: linhas(), error: null } : { data: null, error: null }).then(ok, ko),
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return db;
}

const BANCO = () => ({
  contacts: [
    { id: MEU, organization_id: ORG },
    { id: ALHEIO, organization_id: OUTRA },
  ],
  crm_leads: [
    { id: MEU, organization_id: ORG },
    { id: ALHEIO, organization_id: OUTRA },
  ],
  ai_agents: [
    { id: MEU, organization_id: ORG },
    { id: ALHEIO, organization_id: OUTRA },
  ],
  ai_provider_credentials: [{ id: ALHEIO, organization_id: OUTRA }],
  channel_sessions: [{ id: ALHEIO, organization_id: OUTRA }],
  ai_routers: [{ id: MEU, organization_id: ORG }],
  conversations: [{ id: ALHEIO, organization_id: OUTRA }],
  calendar_event_types: [
    { id: MEU, organization_id: ORG, name: "Consulta", is_active: true, default_owner_user_id: USER },
  ],
  crm_stages: [{ id: MEU, organization_id: ORG, pipeline_id: MEU }],
  user_organizations: [
    { user_id: USER, organization_id: ORG, role: "agent", revoked_at: null },
    { user_id: ALHEIO, organization_id: OUTRA, role: "admin", revoked_at: null },
  ],
});

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  } as never);
});

describe("idsForaDaOrg", () => {
  it("devolve só o que não é desta organização, ignorando nulos", async () => {
    const db = fakeDb(BANCO());
    expect(await idsForaDaOrg(db as never, ORG, "contacts", [MEU, ALHEIO, null, undefined])).toEqual([ALHEIO]);
    expect(await idsForaDaOrg(db as never, ORG, "contacts", [null])).toEqual([]);
  });
});

describe("versão de agente", () => {
  it("credential_id e channel_session_id de outra org são recusados", async () => {
    const db = fakeDb(BANCO());
    expect(await validarEscopoDaVersao(db as never, ORG, { credential_id: ALHEIO })).toMatchObject({
      ok: false,
      campo: "credential_id",
    });
    expect(await validarEscopoDaVersao(db as never, ORG, { channel_session_id: ALHEIO })).toMatchObject({
      ok: false,
      campo: "channel_session_id",
    });
    expect(await validarEscopoDaVersao(db as never, ORG, { credential_id: null, channel_session_id: null })).toEqual({
      ok: true,
    });
  });
});

describe("lead", () => {
  const ctx = { organization_id: ORG, requestId: "r", actor: { type: "user", id: USER } } as never;

  it("contact_id de outra org é 422", async () => {
    const db = fakeDb(BANCO());
    await expect(
      createLeadHandler(db as never, ctx, { pipeline_id: MEU, stage_id: MEU, title: "x", contact_id: ALHEIO } as never),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(db.inserts.crm_leads).toBeUndefined();
  });

  it("owner_user_id que não é da equipe é 422", async () => {
    const db = fakeDb(BANCO());
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    await expect(
      createLeadHandler(db as never, ctx, { pipeline_id: MEU, stage_id: MEU, title: "x", owner_user_id: ALHEIO } as never),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(db.inserts.crm_leads).toBeUndefined();
  });
});

describe("tarefa", () => {
  it("lead_id de outra org é 422 antes do INSERT", async () => {
    const db = fakeDb(BANCO());
    vi.mocked(createClient).mockResolvedValue(db as never);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await criarTarefa(
      new NextRequest("http://x/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "ligar", lead_id: ALHEIO }),
      }),
    );
    expect(res.status).toBe(422);
    expect(db.inserts.crm_tasks).toBeUndefined();
  });
});

describe("roteador", () => {
  it("agent_id de outra org não entra como membro", async () => {
    const db = fakeDb(BANCO());
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await gravarMembros(
      new NextRequest(`http://x/api/v1/ai/routers/${MEU}/members`, {
        method: "PUT",
        body: JSON.stringify({
          members: [{ agent_id: ALHEIO, intent_name: "a", intent_description: "b" }],
        }),
      }),
      { params: Promise.resolve({ id: MEU }) },
    );
    expect(res.status).toBe(422);
    expect(db.inserts.ai_router_members).toBeUndefined();
  });
});

describe("agendamento", () => {
  it("conversation_id de outra org é 422 antes de gravar", async () => {
    const db = fakeDb(BANCO());
    const ctx = { organization_id: ORG, requestId: "r", actor: { type: "user", id: USER } } as never;
    await expect(
      marcarAgendamentoHandler(db as never, ctx, {
        event_type_id: MEU,
        starts_at: "2026-10-01T13:00:00.000Z",
        contact_id: MEU,
        conversation_id: ALHEIO,
      } as never),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(db.inserts.calendar_appointments).toBeUndefined();
  });
});
