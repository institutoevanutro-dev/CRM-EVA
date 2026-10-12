import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRouterById, type LoadedRouter } from "@/lib/agent-engine/agent/router-config";
import { buildFatosDoContato } from "@/lib/agent-engine/agent/fatos-do-contato";
import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 6 (Fase 3 — Intent Router) — POST /api/v1/ai/routers/:id/test:
 *  - classifica uma mensagem de TESTE reusando classifyIntent (o MESMO seam do
 *    runtime), com o roteador carregado por id, ATIVO OU NÃO;
 *  - com `contact_id`, o classificador recebe os fatos da agenda do contato,
 *    e a posse do contato é conferida na organização da SESSÃO antes de ler;
 *  - devolve intent_name/confidence/agent_id/agent_name SEM gravar em
 *    ai_router_decisions (telemetria de decisão real, não de teste).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadRouterById: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/fatos-do-contato", () => ({ buildFatosDoContato: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/intent-classifier", () => ({ classifyIntent: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { ANTHROPIC_API_KEY: "test-key" } }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const FATOS = "Atendimentos anteriores:\n- 02/09/2026: Primeira consulta (realizado)";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";

function mockAuthzOk() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

/**
 * Só `contacts` (posse) e `ai_agents` (nome) existem neste stub: qualquer outra
 * tabela LANÇA. É o que prova que a rota não toca `ai_routers`, `conversations`
 * nem `ai_router_decisions` pelo admin client.
 */
function makeAdminStub(opts: { contactFound?: boolean; agentName?: string | null } = {}) {
  const tabelas: string[] = [];
  const filtrosDoContato: Array<[string, unknown]> = [];
  return {
    tabelas,
    filtrosDoContato,
    from(table: string) {
      tabelas.push(table);
      if (table === "contacts") {
        return {
          select() {
            return this;
          },
          eq(coluna: string, valor: unknown) {
            filtrosDoContato.push([coluna, valor]);
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: opts.contactFound === false ? null : { id: CONTACT_ID },
              error: null,
            });
          },
        };
      }
      if (table === "ai_agents") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: opts.agentName !== undefined ? { name: opts.agentName } : { name: "Agente Vendas" },
              error: null,
            });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const ROTEADOR: LoadedRouter = {
  id: ROUTER_ID,
  name: "Roteador",
  classifierModel: "claude-haiku-4-5",
  classifierProvider: null,
  sticky: true,
  minConfidence: 0.6,
  fallbackAgentId: null,
  members: [{ agentId: AGENT_ID, intentName: "vendas", intentDescription: "Quer comprar", examples: [] }],
};

/** Roteador carregado + classificador casando "vendas"; devolve o stub do admin. */
function cenarioQueClassifica(opts: { contactFound?: boolean } = {}) {
  mockAuthzOk();
  const admin = makeAdminStub(opts);
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  vi.mocked(loadRouterById).mockResolvedValue(ROTEADOR);
  vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.92 });
  return admin;
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/routers/${ROUTER_ID}/test`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ id: ROUTER_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/routers/:id/test", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi" }), ctx());
    expect(res.status).toBe(401);
  });

  it("classifica e devolve intent_name/confidence/agent_id/agent_name, sem gravar ai_router_decisions", async () => {
    const admin = cenarioQueClassifica();

    const { POST } = await import("./route");
    const res = await POST(req({ message: "quanto custa o plano?" }), ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { intent_name: string | null; confidence: number; agent_id: string | null; agent_name: string | null };
    };
    expect(body.data).toEqual({
      intent_name: "vendas",
      confidence: 0.92,
      min_confidence: 0.6,
      agent_id: AGENT_ID,
      agent_name: "Agente Vendas",
      fatos: null,
    });

    // classifyIntent chamado com leadId/jobId null (nunca um uuid inventado —
    // violaria a FK de llm_calls.contact_id/job_id).
    const [, , classifyInput] = vi.mocked(classifyIntent).mock.calls[0]!;
    expect(classifyInput.leadId).toBeNull();
    expect(classifyInput.jobId).toBeNull();

    // Sem contato: nenhum fato é lido, e o classificador roda só com a mensagem.
    expect(classifyInput.fatos).toBeNull();
    expect(buildFatosDoContato).not.toHaveBeenCalled();

    // NUNCA grava em ai_router_decisions — a única tabela tocada pelo admin
    // client é ai_agents (leitura do nome).
    expect(admin.tabelas).toEqual(["ai_agents"]);
    expect(() => admin.from("ai_router_decisions")).toThrow();
  });

  it("confidence abaixo do min_confidence → não casa o membro, cai no fallback do router (espelha resolve-turn-agent)", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ agentName: "Agente Fallback" }) as never);
    vi.mocked(loadRouterById).mockResolvedValue({
      ...ROTEADOR,
      fallbackAgentId: AGENT_ID,
      members: [
        { agentId: "77777777-7777-4777-8777-777777777777", intentName: "vendas", intentDescription: "Quer comprar", examples: [] },
      ],
    });
    vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.4 });

    const { POST } = await import("./route");
    const res = await POST(req({ message: "talvez eu compre" }), ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { intent_name: string | null; confidence: number; min_confidence: number; agent_id: string | null; agent_name: string | null };
    };
    // intent_name reporta o que o classificador viu, mas agent_id NÃO é o
    // membro "vendas" — confidence 0.4 < min_confidence 0.6 cai no fallback,
    // igual à produção (resolve-turn-agent.ts:193).
    expect(body.data).toEqual({
      intent_name: "vendas",
      confidence: 0.4,
      min_confidence: 0.6,
      agent_id: AGENT_ID,
      agent_name: "Agente Fallback",
      fatos: null,
    });
  });

  it("roteador INATIVO → 200 com a classificação, sem tocar is_active nem conversa", async () => {
    // loadRouterById não olha is_active: a rota recebe o roteador e classifica.
    const admin = cenarioQueClassifica();

    const { POST } = await import("./route");
    const res = await POST(req({ message: "quanto custa o plano?" }), ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { intent_name: string | null; agent_id: string | null } };
    expect(body.data.intent_name).toBe("vendas");
    expect(body.data.agent_id).toBe(AGENT_ID);
    expect(loadRouterById).toHaveBeenCalledWith(expect.anything(), ORG_ID, ROUTER_ID);

    // Nada de ai_routers nem conversations pelo admin client (o stub lança em
    // qualquer tabela fora de contacts/ai_agents), e o pool deste teste é `{}`:
    // um `pool.query` de escrita estouraria.
    expect(admin.tabelas).toEqual(["ai_agents"]);
  });

  it("router não encontrado na org (ou de outra organização) → 404", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub() as never);
    vi.mocked(loadRouterById).mockResolvedValue(null);

    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi" }), ctx());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it("contact_id da organização → fatos lidos com a org da SESSÃO e entregues ao classificador", async () => {
    const admin = cenarioQueClassifica();
    vi.mocked(buildFatosDoContato).mockResolvedValue(FATOS);

    const { POST } = await import("./route");
    const res = await POST(req({ message: "quero remarcar", contact_id: CONTACT_ID }), ctx());

    expect(res.status).toBe(200);
    expect(admin.filtrosDoContato).toEqual(
      expect.arrayContaining([
        ["id", CONTACT_ID],
        ["organization_id", ORG_ID],
      ]),
    );
    expect(buildFatosDoContato).toHaveBeenCalledWith(expect.anything(), ORG_ID, CONTACT_ID, expect.any(Date));
    const [, , classifyInput] = vi.mocked(classifyIntent).mock.calls[0]!;
    expect(classifyInput.fatos).toBe(FATOS);
    // O contato do teste não vira lead do registro de custo.
    expect(classifyInput.leadId).toBeNull();
    const body = (await res.json()) as { data: { fatos: string | null } };
    expect(body.data.fatos).toBe(FATOS);
  });

  it("organization_id no corpo é ignorado: a posse é conferida na org da sessão", async () => {
    const admin = cenarioQueClassifica();
    vi.mocked(buildFatosDoContato).mockResolvedValue(FATOS);

    const { POST } = await import("./route");
    const OUTRA = "99999999-9999-4999-8999-999999999999";
    await POST(req({ message: "oi", contact_id: CONTACT_ID, organization_id: OUTRA }), ctx());

    expect(admin.filtrosDoContato).toContainEqual(["organization_id", ORG_ID]);
    expect(admin.filtrosDoContato).not.toContainEqual(["organization_id", OUTRA]);
    expect(buildFatosDoContato).toHaveBeenCalledWith(expect.anything(), ORG_ID, CONTACT_ID, expect.any(Date));
  });

  it("contact_id de OUTRA organização → 404 not_found, sem ler fato nem classificar", async () => {
    // A consulta do contato com filtro de organização não devolve linha.
    cenarioQueClassifica({ contactFound: false });

    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi", contact_id: CONTACT_ID }), ctx());

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(buildFatosDoContato).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it("contact_id que não é uuid → 422 validation_failed", async () => {
    cenarioQueClassifica();
    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi", contact_id: "123" }), ctx());
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(buildFatosDoContato).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it("buildFatosDoContato rejeita → 200, classificação feita com fatos null", async () => {
    cenarioQueClassifica();
    vi.mocked(buildFatosDoContato).mockRejectedValue(new Error("statement timeout"));

    const { POST } = await import("./route");
    const res = await POST(req({ message: "quanto custa?", contact_id: CONTACT_ID }), ctx());

    expect(res.status).toBe(200);
    const [, , classifyInput] = vi.mocked(classifyIntent).mock.calls[0]!;
    expect(classifyInput.fatos).toBeNull();
    const body = (await res.json()) as { data: { intent_name: string | null; fatos: string | null } };
    expect(body.data.intent_name).toBe("vendas");
    expect(body.data.fatos).toBeNull();
  });

  it("body inválido (message vazio) → 422 validation_failed", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");
    const res = await POST(req({ message: "" }), ctx());
    expect(res.status).toBe(422);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
