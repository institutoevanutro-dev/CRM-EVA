import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Auth from "@/lib/mcp/auth";
import { McpAuthError } from "@/lib/mcp/auth";

/**
 * A CHAVE DO FINANCEIRO LÊ UM CONTATO E NADA MAIS.
 *
 * `financeiro:contatos` é o escopo dedicado desta rota. Antes dele, a chave que
 * o Financeiro usa precisava de `mcp:read`, que também abre a leitura de todas
 * as conversas pelo MCP. `mcp:read` continua aceito aqui, para não derrubar a
 * chave que já está instalada. Que o escopo novo não abre outra porta é o
 * trabalho de `tests/unit/escopo-financeiro-contatos-nao-abre-outra-porta.test.ts`.
 *
 * `validateBearerToken` é dublê; `ensureScope`, `ensureRole` e `McpAuthError`
 * são os de verdade, então o 403 medido aqui é o da régua real.
 */
const mocked = vi.hoisted(() => ({
  validate: vi.fn(),
  from: vi.fn(),
  rate: vi.fn(),
  rows: [] as unknown[],
  filters: [] as unknown[][],
  tabelas: {} as Record<string, Record<string, unknown>[] | "erro">,
  getUser: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async (original) => ({
  ...(await original<typeof Auth>()),
  validateBearerToken: mocked.validate,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocked.rate }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mocked.from, auth: { admin: { getUserById: mocked.getUser } } }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const CONTATO = {
  id: ID,
  organization_id: ORG,
  name: "Paciente Fictícia",
  display_name: null,
  phone_number: "+5527999990000",
  email: "ficticia@example.test",
  is_anonymized: false,
};

const { GET } = await import("./route");

function pedir(id = ID) {
  return GET(
    new Request(`https://crm.example.test/api/v1/integrations/financeiro/contacts/${id}`, {
      headers: { authorization: "Bearer dsk_fixture_somente" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

function comEscopos(scopes: string[], organizationId = ORG) {
  mocked.validate.mockResolvedValueOnce({ organizationId, apiTokenId: TOKEN, role: "agent", scopes });
}

async function codigo(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCEIRO_ORGANIZATION_ID", ORG);
  mocked.rows = [{ data: CONTATO, error: null }];
  mocked.filters = [];
  mocked.rate.mockResolvedValue({ allowed: true });
  mocked.tabelas = { conversations: [], user_organizations: [] };
  mocked.getUser.mockImplementation(async (id: string) => ({
    data: { user: { id, email: `${id.slice(0, 4)}@clinica.example.test` } },
    error: null,
  }));
  mocked.from.mockImplementation((tabela: string) => {
    if (tabela !== "contacts") return tabelaFalsa(tabela);
    const chain = {
      select: () => chain,
      eq: (...args: unknown[]) => {
        mocked.filters.push(args);
        return chain;
      },
      maybeSingle: async () => mocked.rows.shift(),
    };
    return chain;
  });
});
afterEach(() => vi.unstubAllEnvs());

/** Tabela em memória que respeita `eq` e `order`: o vazamento entre organizações é medido, não suposto. */
function tabelaFalsa(tabela: string) {
  const conds: [string, unknown][] = [];
  const ordens: [string, boolean][] = [];
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => (conds.push([col, val]), chain),
    order: (col: string, opts?: { ascending?: boolean }) => (ordens.push([col, opts?.ascending ?? true]), chain),
    limit: () => chain,
    maybeSingle: async () => {
      const linhas = mocked.tabelas[tabela];
      if (linhas === "erro") return { data: null, error: { message: "fora do ar" } };
      const achadas = (linhas ?? [])
        .filter((l) => conds.every(([c, v]) => l[c] === v))
        .sort((a, b) => {
          for (const [col, asc] of ordens) {
            const x = String(a[col] ?? ""), y = String(b[col] ?? "");
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      return { data: achadas[0] ?? null, error: null };
    },
  };
  return chain;
}

const ATENDENTE = "55555555-5555-4555-8555-555555555555";
const OUTRO_ATENDENTE = "66666666-6666-4666-8666-666666666666";
function conversa(extra: Record<string, unknown>) {
  return {
    organization_id: ORG,
    contact_id: ID,
    assigned_to_user_id: null,
    assignee_kind: null,
    last_message_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    ...extra,
  };
}

describe("GET /api/v1/integrations/financeiro/contacts/[id]", () => {
  it("a chave dedicada financeiro:contatos lê os campos do contato da organização", async () => {
    comEscopos(["financeiro:contatos"]);
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toEqual({
      id: ID,
      organization_id: ORG,
      name: "Paciente Fictícia",
      phone: "+5527999990000",
      email: "ficticia@example.test",
      assigned_email: null,
    });
    expect(mocked.filters).toContainEqual(["organization_id", ORG]);
    expect(mocked.filters).toContainEqual(["id", ID]);
  });

  it("a chave antiga com mcp:read continua lendo, para não quebrar a instalação que já existe", async () => {
    comEscopos(["mcp:read"]);
    expect((await pedir()).status).toBe(200);
  });

  it("contato que não existe responde exatamente 404, a prova que o instalador usa", async () => {
    const aleatorio = randomUUID();
    mocked.rows = [{ data: null, error: null }];
    comEscopos(["financeiro:contatos"]);
    const res = await pedir(aleatorio);
    expect(res.status).toBe(404);
    expect(mocked.filters).toContainEqual(["id", aleatorio]);
  });

  it("escopo vizinho ou parecido não abre a rota, e o banco nem é consultado", async () => {
    for (const scopes of [
      [],
      ["agenda:read"],
      ["prontuario:contacts:read"],
      ["contacts:read"],
      ["mcp:write"],
      ["financeiro"],
      ["financeiro:contatos:write"],
      ["FINANCEIRO:CONTATOS"],
      [" financeiro:contatos"],
    ]) {
      comEscopos(scopes);
      const res = await pedir();
      expect(res.status, JSON.stringify(scopes)).toBe(403);
      expect(await codigo(res)).toBe("unauthenticated");
    }
    expect(mocked.from).not.toHaveBeenCalled();
  });

  it("chave expirada ou revogada responde 401 antes do banco, nunca 404", async () => {
    mocked.validate.mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token expired."));
    const res = await pedir();
    expect(res.status).toBe(401);
    expect(mocked.from).not.toHaveBeenCalled();
  });

  it("CRM ainda sem a organização do Financeiro configurada recusa com código diferente da falta de escopo", async () => {
    vi.stubEnv("FINANCEIRO_ORGANIZATION_ID", "");
    comEscopos(["financeiro:contatos"]);
    const semConfig = await pedir();
    expect(semConfig.status).toBe(403);
    expect(await codigo(semConfig)).toBe("forbidden");

    vi.stubEnv("FINANCEIRO_ORGANIZATION_ID", ORG);
    comEscopos(["financeiro:contatos"], OUTRA_ORG);
    const outraOrg = await pedir();
    expect(outraOrg.status).toBe(403);
    expect(await codigo(outraOrg)).toBe("forbidden");
    expect(mocked.from).not.toHaveBeenCalled();
  });

  describe("assigned_email: quem assumiu o cliente vira o vendedor da proposta no Financeiro", () => {
    async function assumido(): Promise<unknown> {
      mocked.rows = [{ data: CONTATO, error: null }];
      comEscopos(["financeiro:contatos"]);
      const res = await pedir();
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { assigned_email: unknown } }).data.assigned_email;
    }

    it("devolve o e-mail de quem assumiu a conversa mais recente do contato", async () => {
      mocked.tabelas.conversations = [
        conversa({ assigned_to_user_id: OUTRO_ATENDENTE, assignee_kind: "user", last_message_at: "2026-10-01T10:00:00Z" }),
        conversa({ assigned_to_user_id: ATENDENTE, assignee_kind: "user", last_message_at: "2026-11-05T10:00:00Z" }),
      ];
      mocked.tabelas.user_organizations = [
        { organization_id: ORG, user_id: ATENDENTE },
        { organization_id: ORG, user_id: OUTRO_ATENDENTE },
      ];
      expect(await assumido()).toBe("5555@clinica.example.test");
      expect(mocked.getUser).toHaveBeenCalledWith(ATENDENTE);
    });

    it("sem conversa, sem assumido ou com a IA no comando devolve null", async () => {
      expect(await assumido()).toBeNull();
      mocked.tabelas.conversations = [conversa({})];
      expect(await assumido()).toBeNull();
      mocked.tabelas.conversations = [conversa({ assignee_kind: "ai" })];
      expect(await assumido()).toBeNull();
      expect(mocked.getUser).not.toHaveBeenCalled();
    });

    it("conversa de outra organização não vaza, nem atendente que não é membro da organização", async () => {
      mocked.tabelas.conversations = [
        conversa({ organization_id: OUTRA_ORG, assigned_to_user_id: OUTRO_ATENDENTE, assignee_kind: "user", last_message_at: "2026-11-07T10:00:00Z" }),
      ];
      mocked.tabelas.user_organizations = [{ organization_id: OUTRA_ORG, user_id: OUTRO_ATENDENTE }];
      expect(await assumido()).toBeNull();

      mocked.tabelas.conversations = [conversa({ assigned_to_user_id: OUTRO_ATENDENTE, assignee_kind: "user" })];
      expect(await assumido()).toBeNull();
      expect(mocked.getUser).not.toHaveBeenCalled();
    });

    it("falha ao buscar o assumido nunca derruba o contato: devolve null e segue", async () => {
      mocked.tabelas.conversations = "erro";
      expect(await assumido()).toBeNull();

      mocked.tabelas.conversations = [conversa({ assigned_to_user_id: ATENDENTE, assignee_kind: "user" })];
      mocked.tabelas.user_organizations = [{ organization_id: ORG, user_id: ATENDENTE }];
      mocked.getUser.mockRejectedValueOnce(new Error("GoTrue fora"));
      expect(await assumido()).toBeNull();
    });
  });
});
