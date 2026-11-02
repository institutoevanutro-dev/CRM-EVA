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
}));
vi.mock("@/lib/mcp/auth", async (original) => ({
  ...(await original<typeof Auth>()),
  validateBearerToken: mocked.validate,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocked.rate }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocked.from }) }));

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
  mocked.from.mockImplementation(() => {
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

describe("GET /api/v1/integrations/financeiro/contacts/[id]", () => {
  it("a chave dedicada financeiro:contatos lê os cinco campos do contato da organização", async () => {
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
});
