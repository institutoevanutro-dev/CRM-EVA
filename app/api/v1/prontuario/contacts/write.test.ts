import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuthError } from "@/lib/mcp/auth";
import { isPublicPath } from "@/lib/auth/public-paths";

const mocked = vi.hoisted(() => ({ validate: vi.fn(), rpc: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), is: vi.fn(), maybeSingle: vi.fn(), audit: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/mcp/auth", async importOriginal => ({
  ...(await importOriginal() as Record<string, unknown>),
  validateBearerToken: mocked.validate,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocked.rpc, from: mocked.from }) }));
vi.mock("@/lib/audit", () => ({ audit: mocked.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocked.rate }));

const ORG = "02820000-0000-4000-8000-000000000001";
const TOKEN = "02820000-0000-4000-8000-000000000002";
const PATIENT = "02820000-0000-4000-8000-000000000003";
const CONTACT = "02820000-0000-4000-8000-000000000004";
const KEY = "02820000-0000-4000-8000-000000000005";
const UPDATED = "2026-01-01T00:00:00.000Z";
const profile = { name: "Pessoa Fictícia", birthdate: "1990-01-01", phone_number: "+5527999990000", email: "pessoa@example.test" };
function request(path: string, method: string, body: unknown) {
  return new Request(`http://localhost${path}`, { method, headers: { authorization: "Bearer dsk_test_secret", "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.validate.mockResolvedValue({ organizationId: ORG, apiTokenId: TOKEN, scopes: ["prontuario:contacts:write"], role: "agent" });
  mocked.rate.mockResolvedValue({ allowed: true });
  mocked.rpc.mockResolvedValue({ data: { id: CONTACT, updated_at: UPDATED, created: true, linked: true, applied: true, revision: 1 }, error: null });
  mocked.from.mockReturnValue({ select: mocked.select });
  mocked.select.mockReturnValue({ eq: mocked.eq });
  mocked.eq.mockReturnValue({ eq: mocked.eq, is: mocked.is });
  mocked.is.mockReturnValue({ maybeSingle: mocked.maybeSingle });
  mocked.maybeSingle.mockResolvedValue({ data: { id: CONTACT, ...profile, updated_at: UPDATED }, error: null });
});

describe("prontuário: escrita restrita de contatos", () => {
  it("Bearer chega às três rotas, sem liberar subcaminhos arbitrários", () => {
    expect(isPublicPath("/api/v1/prontuario/contacts")).toBe(true);
    expect(isPublicPath("/api/v1/prontuario/contacts/link")).toBe(true);
    expect(isPublicPath(`/api/v1/prontuario/contacts/${CONTACT}`)).toBe(true);
    expect(isPublicPath("/api/v1/prontuario/contacts/qualquer-coisa/extra")).toBe(false);
  });

  it("cria com organização e token autenticados; rejeita conteúdo clínico", async () => {
    const { POST } = await import("./route");
    const path = "/api/v1/prontuario/contacts";
    const valid = { ...profile, source_patient_id: PATIENT, request_key: KEY, confirmed_no_match: true };
    expect((await POST(request(path, "POST", { ...valid, anamnese: "não permitido" }))).status).toBe(422);
    expect((await POST(request(path, "POST", { ...valid, organization_id: "02820000-0000-4000-8000-000000000099" }))).status).toBe(422);
    expect(mocked.rpc).not.toHaveBeenCalled();
    const response = await POST(request(path, "POST", valid));
    expect(response.status).toBe(201);
    expect(mocked.rpc).toHaveBeenCalledWith("fn_prontuario_create_contact", expect.objectContaining({ p_org: ORG, p_patient: PATIENT, p_token: TOKEN, p_key: KEY }));
    expect(JSON.stringify(mocked.rpc.mock.calls[0]?.[1])).not.toContain("anamnese");
    expect(mocked.audit).toHaveBeenCalledTimes(1);
  });

  it("token de agenda/MCP não escreve; revogação fecha em 401", async () => {
    const { POST } = await import("./route");
    const body = { ...profile, source_patient_id: PATIENT, request_key: KEY, confirmed_no_match: true };
    mocked.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes: ["agenda:read", "mcp:write"], role: "agent" });
    expect((await POST(request("/api/v1/prontuario/contacts", "POST", body))).status).toBe(403);
    mocked.validate.mockRejectedValueOnce(new McpAuthError(-32001, 401, "Revoked"));
    expect((await POST(request("/api/v1/prontuario/contacts", "POST", body))).status).toBe(401);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("repetição da criação não audita nova mutação", async () => {
    mocked.rpc.mockResolvedValueOnce({ data: { id: CONTACT, updated_at: UPDATED, created: false }, error: null });
    const { POST } = await import("./route");
    const response = await POST(request("/api/v1/prontuario/contacts", "POST", { ...profile, source_patient_id: PATIENT, request_key: KEY, confirmed_no_match: true }));
    expect(response.status).toBe(200);
    expect(mocked.audit).not.toHaveBeenCalled();
  });

  it("vínculo exige confirmação e revisão vista na prévia", async () => {
    const { POST } = await import("./link/route");
    const path = "/api/v1/prontuario/contacts/link";
    const body = { source_patient_id: PATIENT, contact_id: CONTACT, expected_updated_at: UPDATED, confirmed: true };
    expect((await POST(request(path, "POST", { ...body, confirmed: false }))).status).toBe(422);
    expect((await POST(request(path, "POST", body))).status).toBe(200);
    expect(mocked.rpc).toHaveBeenCalledWith("fn_prontuario_link_existing", expect.objectContaining({ p_org: ORG, p_patient: PATIENT, p_contact: CONTACT, p_expected: UPDATED }));
    expect(mocked.audit).toHaveBeenCalledTimes(1);
    mocked.rpc.mockResolvedValueOnce({ data: { id: CONTACT, updated_at: UPDATED, linked: false }, error: null });
    expect((await POST(request(path, "POST", body))).status).toBe(200);
    expect(mocked.audit).toHaveBeenCalledTimes(1);
  });

  it("PATCH envia só quatro campos e revisão; conflito não audita", async () => {
    const { PATCH } = await import("./[id]/route");
    const path = `/api/v1/prontuario/contacts/${CONTACT}`;
    const body = { ...profile, source_patient_id: PATIENT, revision: 1, expected_updated_at: UPDATED };
    mocked.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "prontuario_revision_conflict" } });
    expect((await PATCH(request(path, "PATCH", body), { params: Promise.resolve({ id: CONTACT }) })).status).toBe(409);
    expect(mocked.audit).not.toHaveBeenCalled();
    expect((await PATCH(request(path, "PATCH", body), { params: Promise.resolve({ id: CONTACT }) })).status).toBe(200);
    expect(mocked.rpc).toHaveBeenCalledWith("fn_prontuario_patch_contact", expect.objectContaining({ p_org: ORG, p_patient: PATIENT, p_contact: CONTACT, p_revision: 1 }));
    expect(mocked.audit).toHaveBeenCalledTimes(1);
  });

  it("consulta contato vinculado somente na organização do token", async () => {
    mocked.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes: ["prontuario:contacts:read"], role: "agent" });
    const { GET } = await import("./[id]/route");
    const response = await GET(new Request(`http://localhost/api/v1/prontuario/contacts/${CONTACT}`, { headers: { authorization: "Bearer dsk_test_secret" } }), { params: Promise.resolve({ id: CONTACT }) });
    expect(response.status).toBe(200);
    expect(mocked.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(mocked.select).toHaveBeenCalledWith("id,name,birthdate,phone_number,email,updated_at");
  });
});
