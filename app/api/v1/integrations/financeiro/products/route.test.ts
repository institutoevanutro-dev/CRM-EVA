import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

vi.mock("@/lib/mcp/auth", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const PRODUTO = {
  id: "44444444-4444-4444-8444-444444444444",
  codigo: "MASS-DREN-1",
  nome: "Drenagem linfática - 1 sessão",
  categoria: "Massoterapia",
  preco_cents: 18000,
  moeda: "BRL",
  ativo: true,
};

/** O que a rota pediu ao banco: colunas e a organização do filtro. */
let pedido: { colunas: string; org: string | null } = { colunas: "", org: null };

function bancoCom(linhas: unknown[], erro: unknown = null) {
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: (colunas: string) => {
        pedido = { colunas, org: null };
        return {
          eq: (_coluna: string, valor: string) => {
            pedido.org = valor;
            return { order: () => ({ limit: async () => ({ data: linhas, error: erro }) }) };
          },
        };
      },
    }),
  } as never);
}

const chama = () =>
  GET(new Request("https://crm.test/api/v1/integrations/financeiro/products", {
    headers: { authorization: "Bearer tok_teste" },
  }));

const tokenDa = (organizationId: string, scopes = ["mcp:read"], role = "agent") =>
  vi.mocked(validateBearerToken).mockResolvedValue({ organizationId, scopes, role } as never);

beforeEach(() => {
  vi.stubEnv("FINANCEIRO_ORGANIZATION_ID", ORG);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  bancoCom([PRODUTO]);
  tokenDa(ORG);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/v1/integrations/financeiro/products", () => {
  it("devolve os produtos da organização do token, sem o custo", async () => {
    const r = await chama();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const corpo = await r.json();
    expect(corpo.data).toEqual({ organization_id: ORG, produtos: [PRODUTO] });
    expect(pedido.org).toBe(ORG);
    expect(pedido.colunas).not.toContain("custo");
  });

  it("token de OUTRA organização não lê o catálogo, nem chega ao banco", async () => {
    tokenDa(OUTRA);
    const r = await chama();
    expect(r.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("sem credencial válida ou sem o escopo de leitura: recusado", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "x"));
    expect((await chama()).status).toBe(401);
    tokenDa(ORG, ["mcp:write"]);
    expect((await chama()).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("acima do limite por minuto: 429", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await chama()).status).toBe(429);
  });

  it("catálogo acima do teto vira erro, nunca lista cortada com cara de completa", async () => {
    bancoCom(Array.from({ length: 2001 }, () => PRODUTO));
    expect((await chama()).status).toBe(503);
  });

  it("falha do banco: 503", async () => {
    bancoCom([], { message: "x" });
    expect((await chama()).status).toBe(503);
  });
});
