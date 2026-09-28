import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuthError } from "@/lib/mcp/auth";
import { isPublicPath } from "@/lib/auth/public-paths";

const auth = vi.hoisted(() => ({ validate: vi.fn(), scope: vi.fn() }));
const db = vi.hoisted(() => ({ client: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), is: vi.fn(), or: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/mcp/auth", async importOriginal => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, validateBearerToken: auth.validate, ensureScope: auth.scope };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: db.client }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const row = { id: "11111111-1111-4111-8111-111111111111", name: null, display_name: "Pessoa Teste", birthdate: "1990-01-01", phone_number: "+5527999990000", email: "teste@example.test", updated_at: "2026-01-01T00:00:00Z", cpf_encrypted: "must-not-leak" };
const request = (search = "Pessoa") => new Request(`http://localhost/api/v1/prontuario/contacts?search=${encodeURIComponent(search)}&limit=10`, { headers: { authorization: "Bearer dsk_test_secret" } });

beforeEach(() => {
  vi.clearAllMocks();
  auth.validate.mockResolvedValue({ organizationId: ORG, scopes: ["prontuario:contacts:read"], role: "agent" });
  auth.scope.mockImplementation((scopes: string[], required: string) => { if (!scopes.includes(required)) throw new McpAuthError(-32002, 403, "Missing scope"); });
  db.client.mockReturnValue({ from: db.from });
  db.from.mockReturnValue({ select: db.select });
  db.select.mockReturnValue({ eq: db.eq });
  db.eq.mockReturnValue({ eq: db.eq, is: db.is });
  db.is.mockReturnValue({ is: db.is, or: db.or });
  db.or.mockReturnValue({ limit: db.limit });
  db.limit.mockResolvedValue({ data: [row], error: null });
});

describe("prontuário: busca limitada de contatos", () => {
  it("aceita Bearer no proxy, filtra org do token e devolve só campos permitidos", async () => {
    expect(isPublicPath("/api/v1/prontuario/contacts")).toBe(true);
    expect(isPublicPath("/api/v1/prontuario/contacts/extra")).toBe(false);
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(db.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(db.select.mock.calls[0]?.[0]).toBe("id,name,display_name,birthdate,phone_number,email,updated_at");
    expect(db.or.mock.calls[0]?.[0]).toContain("display_name.ilike.%Pessoa%");
    const body = await response.json();
    expect(body.data[0]).toEqual({ id: row.id, name: row.display_name, birthdate: row.birthdate, phone_number: row.phone_number, email: row.email, updated_at: row.updated_at });
    expect(JSON.stringify(body)).not.toContain("cpf_encrypted");
  });

  it("recusa token sem permissão exclusiva e não consulta contatos", async () => {
    auth.validate.mockResolvedValue({ organizationId: ORG, scopes: ["agenda:read", "mcp:read"], role: "agent" });
    const { GET } = await import("./route");
    expect((await GET(request())).status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("recusa token inválido e busca vazia", async () => {
    const { GET } = await import("./route");
    auth.validate.mockRejectedValueOnce(new McpAuthError(-32001, 401, "Invalid token"));
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(" "))).status).toBe(422);
  });
});
