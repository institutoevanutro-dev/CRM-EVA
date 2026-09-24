import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bearer: vi.fn(),
  db: vi.fn(),
  limit: vi.fn(),
  remote: vi.fn(),
  config: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/mcp/auth", () => ({
  validateBearerToken: mocks.bearer,
  ensureScope: (s: string[], r: string) => {
    if (!s.includes(r)) throw new Error("scope");
  },
  ensureRole: vi.fn(),
  McpAuthError: class extends Error {
    httpStatus = 401;
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.db }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.db }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.limit }));
vi.mock("@/lib/integrations/financeiro/cliente", () => ({
  configFinanceiro: mocks.config,
  consultaFinanceiro: mocks.remote,
}));
import { GET as summary } from "@/app/api/v1/contacts/[id]/financeiro/route";
import { GET as contact } from "@/app/api/v1/integrations/financeiro/contacts/[id]/route";
const org = "10000000-0000-4000-8000-000000000001",
  id = "20000000-0000-4000-8000-000000000002";
const ctx = { params: Promise.resolve({ id }) };
let eq: ReturnType<typeof vi.fn>;
function database(data: unknown) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  eq = chain.eq;
  mocks.db.mockReturnValue({ from: vi.fn().mockReturnValue(chain) });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCEIRO_ORGANIZATION_ID", org);
  mocks.auth.mockResolvedValue({ ok: true, org: { orgId: org } });
  mocks.bearer.mockResolvedValue({ organizationId: org, scopes: ["mcp:read"], role: "agent" });
  mocks.limit.mockResolvedValue({ allowed: true });
  mocks.config.mockReturnValue({ url: "https://financeiro.example.test", token: "servidor" });
  mocks.remote.mockResolvedValue({ resumo: null });
  database({ id, is_anonymized: false });
});
afterEach(() => vi.unstubAllEnvs());
it("nega perfil insuficiente antes de buscar dados ou financeiro", async () => {
  mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await summary(new Request("https://crm.test"), ctx)).status).toBe(403);
  expect(mocks.db).not.toHaveBeenCalled();
  expect(mocks.remote).not.toHaveBeenCalled();
});
it("contato ausente ou anonimizado não chama financeiro; consulta filtra org ativa", async () => {
  database({ id, is_anonymized: true });
  expect((await summary(new Request("https://crm.test"), ctx)).status).toBe(404);
  expect(eq).toHaveBeenCalledWith("organization_id", org);
  expect(mocks.remote).not.toHaveBeenCalled();
});
it("falha remota é 503 e nunca saldo zero", async () => {
  mocks.remote.mockRejectedValue(new Error("token secreto"));
  const r = await summary(new Request("https://crm.test"), ctx);
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("token secreto");
});
it("exportação rejeita token de outra organização antes do banco", async () => {
  mocks.bearer.mockResolvedValue({ organizationId: id, scopes: ["mcp:read"], role: "agent" });
  expect((await contact(new Request("https://crm.test"), ctx)).status).toBe(403);
  expect(mocks.db).not.toHaveBeenCalled();
});
it("exporta somente os cinco campos comerciais e recusa anonimizado", async () => {
  database({
    id,
    organization_id: org,
    name: "Fictício",
    display_name: null,
    phone_number: "+5527999993333",
    email: null,
    is_anonymized: false,
    cpf: "não exportar",
  });
  const r = await contact(new Request("https://crm.test"), ctx);
  expect(r.status).toBe(200);
  expect(eq).toHaveBeenCalledWith("organization_id", org);
  expect((await r.json()).data).toEqual({
    id,
    organization_id: org,
    name: "Fictício",
    phone: "+5527999993333",
    email: null,
  });
  database({ id, is_anonymized: true });
  expect((await contact(new Request("https://crm.test"), ctx)).status).toBe(404);
});
