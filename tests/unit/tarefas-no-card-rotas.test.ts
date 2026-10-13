/**
 * AS ROTAS POR TRÁS DAS TAREFAS NO CARD (porte do PR #2760 do upstream).
 *
 * `tarefas-rota-nao-tem-porta-dos-fundos` e `tarefa-responsavel` já provam
 * papel, organização da sessão, validação, responsável da equipe, auditoria da
 * criação e a linha do tempo. Aqui fica o que chegou agora:
 *
 *  - o QUADRO traz o selo com UMA leitura de `crm_tasks`, filtrada pela
 *    organização do funil e pelo funil, e cai com 500 se ela falhar;
 *  - a lista de tarefas pede o negócio embutido (`lead:crm_leads`);
 *  - a tarefa que a sessão não enxerga (a RLS da 0359 devolve zero linhas) é
 *    404 no PATCH e no DELETE, sem auditoria e sem linha do tempo;
 *  - editar e apagar auditam.
 *
 * A regra de QUEM vê o quê é do banco e é medida no Postgres de verdade, em
 * `tests/invariants/tarefas-seguem-a-visibilidade-do-negocio.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const TAREFA = "55555555-5555-4555-8555-555555555555";

function sessao(papel: Role = "agent") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
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

interface Consulta {
  tabela: string;
  select?: string;
  filtros: Array<[string, string, unknown]>;
}
type Resposta = { data?: unknown; error?: { code?: string; message: string } | null };

/** Dublê do PostgREST: anota tabela, `select` e filtros de cada consulta, e responde por tabela. */
function banco(porTabela: Record<string, Resposta | Resposta[]>) {
  const consultas: Consulta[] = [];
  const vez: Record<string, number> = {};
  const from = (tabela: string) => {
    const consulta: Consulta = { tabela, filtros: [] };
    consultas.push(consulta);
    const devolve = () => {
      const r = porTabela[tabela];
      const i = (vez[tabela] = (vez[tabela] ?? 0) + 1) - 1;
      const escolhida = Array.isArray(r) ? r[Math.min(i, r.length - 1)] : r;
      return Promise.resolve({ data: escolhida?.data ?? null, error: escolhida?.error ?? null, count: 0 });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elo: any = new Proxy(() => elo, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => devolve().then(ok, ko);
        if (prop === "single" || prop === "maybeSingle") return devolve;
        if (prop === "select") {
          return (colunas?: string) => {
            if (typeof colunas === "string") consulta.select = colunas;
            return elo;
          };
        }
        return (...args: unknown[]) => {
          if (["eq", "in", "neq"].includes(prop)) consulta.filtros.push([prop, args[0] as string, args[1]]);
          return elo;
        };
      },
    });
    return elo;
  };
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: ANA } }, error: null }) },
    from,
  } as never);
  return consultas;
}

const LINHA = {
  id: TAREFA,
  organization_id: ORG,
  title: "Ligar de volta",
  description: null,
  due_date: null,
  priority: "medium",
  status: "pending",
  lead_id: LEAD,
  contact_id: null,
  assigned_to: null,
  created_by: ANA,
  created_at: "2026-10-11T10:00:00.000Z",
  updated_at: "2026-10-11T10:00:00.000Z",
};

const ctx = { params: Promise.resolve({ id: TAREFA }) };
const patch = (corpo: Record<string, unknown>) =>
  new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  sessao();
});

describe("GET /api/v1/pipelines/[id]/board — o selo de tarefas", () => {
  const negocio = (id: string) => ({
    id,
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: "st-1",
    contact_id: null,
    status: "open",
    owner_kind: null,
    owner_agent_id: null,
    last_activity_at: null,
    created_at: "2026-01-01T00:00:00Z",
  });
  const abrir = async () => {
    const { GET } = await import("@/app/api/v1/pipelines/[id]/board/route");
    return GET(new NextRequest(`http://localhost/api/v1/pipelines/${FUNIL}/board`), {
      params: Promise.resolve({ id: FUNIL }),
    });
  };

  it("⭐ cada card recebe as SUAS tarefas abertas e atrasadas, com uma leitura só de crm_tasks", async () => {
    const consultas = banco({
      crm_pipelines: { data: { id: FUNIL, organization_id: ORG, is_default: true } },
      crm_stages: { data: [] },
      crm_leads: { data: [negocio("l-1"), negocio("l-2"), negocio("l-3")] },
      crm_tasks: {
        data: [
          { lead_id: "l-1", due_date: "2000-01-01T12:00:00Z", status: "pending" },
          { lead_id: "l-1", due_date: null, status: "in_progress" },
          { lead_id: "l-2", due_date: "2999-01-01T12:00:00Z", status: "pending" },
          { lead_id: "fora-do-recorte", due_date: null, status: "pending" },
        ],
      },
    });

    const res = await abrir();

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { leads: Array<{ id: string; tarefas?: unknown }> } };
    expect(corpo.data.leads.map((l) => [l.id, l.tarefas])).toEqual([
      ["l-1", { abertas: 2, atrasadas: 1 }],
      ["l-2", { abertas: 1, atrasadas: 0 }],
      ["l-3", undefined],
    ]);

    const deTarefas = consultas.filter((c) => c.tabela === "crm_tasks");
    expect(deTarefas).toHaveLength(1);
    // Organização do FUNIL (que a RLS já validou), o próprio funil pela junção,
    // só as abertas, e nenhuma lista de ids de negócio.
    expect(deTarefas[0]?.select).toContain("crm_leads!inner");
    expect(deTarefas[0]?.filtros).toEqual([
      ["eq", "organization_id", ORG],
      ["eq", "crm_leads.pipeline_id", FUNIL],
      ["in", "status", ["pending", "in_progress"]],
    ]);
  });

  it("quadro vazio nem consulta as tarefas", async () => {
    const consultas = banco({
      crm_pipelines: { data: { id: FUNIL, organization_id: ORG, is_default: true } },
      crm_stages: { data: [] },
      crm_leads: { data: [] },
    });

    expect((await abrir()).status).toBe(200);
    expect(consultas.filter((c) => c.tabela === "crm_tasks")).toEqual([]);
  });

  it("falha ao ler as tarefas derruba o quadro com 500, em vez de sumir com o selo em silêncio", async () => {
    banco({
      crm_pipelines: { data: { id: FUNIL, organization_id: ORG, is_default: true } },
      crm_stages: { data: [] },
      crm_leads: { data: [negocio("l-1")] },
      crm_tasks: { error: { message: "statement timeout" } },
    });

    expect((await abrir()).status).toBe(500);
  });
});

describe("/api/v1/tasks — o negócio embutido e a tarefa que a sessão não enxerga", () => {
  it("a lista pede o negócio embutido, filtra pelo negócio do dossiê e pela organização da sessão", async () => {
    const consultas = banco({ crm_tasks: { data: [{ ...LINHA, lead: { id: LEAD, title: "Maria, avaliação" } }] } });
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(new NextRequest(`http://x/api/v1/tasks?lead_id=${LEAD}`));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { tasks: Array<{ lead?: { title: string } }> } };
    expect(corpo.data.tasks[0]?.lead?.title).toBe("Maria, avaliação");
    expect(consultas[0]?.select).toContain("lead:crm_leads(id, title)");
    expect(consultas[0]?.filtros).toEqual([
      ["eq", "organization_id", ORG],
      ["eq", "lead_id", LEAD],
    ]);
  });

  it("⭐ PATCH em tarefa que a RLS esconde é 404, sem auditoria e sem linha do tempo", async () => {
    banco({
      crm_tasks: [{ data: null }, { error: { code: "PGRST116", message: "0 rows" } }],
    });
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ status: "done" }), ctx);

    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("⭐ DELETE em tarefa que a RLS esconde é 404, sem auditoria", async () => {
    banco({ crm_tasks: { data: [] } });
    const { DELETE } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await DELETE(new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, { method: "DELETE" }), ctx);

    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("editar audita com os campos mexidos; reabrir não escreve 'concluída' na linha do tempo", async () => {
    banco({ crm_tasks: [{ data: { status: "done" } }, { data: { ...LINHA, status: "pending" } }] });
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ status: "pending" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm_task.updated",
        organizationId: ORG,
        actorUserId: ANA,
        resourceId: TAREFA,
        metadata: { campos: ["status"] },
      }),
    );
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("apagar audita", async () => {
    banco({ crm_tasks: { data: [{ id: TAREFA }] } });
    const { DELETE } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await DELETE(new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, { method: "DELETE" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm_task.deleted", organizationId: ORG, resourceId: TAREFA }),
    );
  });

  it("somente leitura não edita nem apaga", async () => {
    sessao("viewer");
    banco({ crm_tasks: { data: LINHA } });
    const { PATCH, DELETE } = await import("@/app/api/v1/tasks/[id]/route");

    expect((await PATCH(patch({ status: "done" }), ctx)).status).toBe(403);
    expect((await DELETE(new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, { method: "DELETE" }), ctx)).status).toBe(403);
  });
});
