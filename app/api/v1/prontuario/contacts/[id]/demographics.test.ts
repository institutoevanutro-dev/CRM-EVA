import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuthError } from "@/lib/mcp/auth";

const mocked = vi.hoisted(() => ({ validate: vi.fn(), from: vi.fn(), rpc: vi.fn(), audit: vi.fn(), rate: vi.fn(), rows: [] as unknown[], filters: [] as unknown[][] }));
vi.mock("@/lib/mcp/auth", async original => ({ ...await original<typeof import("@/lib/mcp/auth")>(), validateBearerToken: mocked.validate }));
vi.mock("@/lib/audit", () => ({ audit: mocked.audit }));
vi.mock("@/lib/audit/leitura", () => ({ auditarLeitura: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocked.rate }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocked.from, rpc: mocked.rpc }) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const CPF = "52998224725"; // Fixture sintética, nunca cadastro real.
const READ = "prontuario:contacts:read";
const DEMOGRAPHICS = "prontuario:contacts:demographics:read";
const ADDRESS = { cep: "29000000", logradouro: "Rua Fictícia", numero: "10", complemento: "", bairro: "Centro", cidade: "Vitória", uf: "ES" };
const ADDRESS_TEXT = "Rua Fictícia, 10, Centro, Vitória, ES, 29000000";
const row = { id: ID, name: "Paciente Fictício", display_name: null, birthdate: "1990-01-01", phone_number: "+5527999990000", email: "pessoa@example.test", updated_at: "2026-10-01T00:00:00Z", cpf_encrypted: "cipher-never-exposed", custom_fields: { endereco: ADDRESS_TEXT, endereco_estruturado: ADDRESS } };
const { GET } = await import("./route");
const request = (query = "?include=demographics") => GET(new Request(`https://example.test/api/v1/prontuario/contacts/${ID}${query}`, { headers: { authorization: "Bearer fixture-only" } }), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocked.rows = [{ data: row, error: null }, { data: row, error: null }];
  mocked.filters = [];
  mocked.validate.mockResolvedValue({ organizationId: ORG, apiTokenId: TOKEN, scopes: [READ, DEMOGRAPHICS], role: "agent" });
  mocked.rate.mockResolvedValue({ allowed: true });
  mocked.rpc.mockResolvedValue({ data: CPF, error: null });
  mocked.from.mockImplementation(() => {
    const chain = { select: () => chain, eq: (...args: unknown[]) => { mocked.filters.push(args); return chain; }, is: (...args: unknown[]) => { mocked.filters.push(args); return chain; }, maybeSingle: async () => mocked.rows.shift() };
    return chain;
  });
});

describe("demografia exportada somente ao servidor do prontuário", () => {
  it("exige os dois escopos antes de consultar ou decifrar", async () => {
    for (const scopes of [[READ], [DEMOGRAPHICS], ["mcp:read", "agenda:read"], []]) {
      mocked.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes });
      const response = await request();
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocked.from).not.toHaveBeenCalled();
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("recusa token revogado, include desconhecido e parâmetros repetidos", async () => {
    mocked.validate.mockRejectedValueOnce(new McpAuthError(-32001, 401, "Revogado"));
    expect((await request()).status).toBe(401);
    for (const query of ["?include=cpf", "?include=", "?include=demographics&include=cpf"])
      expect((await request(query)).status).toBe(422);
    expect(mocked.from).not.toHaveBeenCalled();
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("GET sem opt-in mantém o contrato público mesmo com escopo sensível", async () => {
    const response = await request("");
    const body = await response.json();
    expect(body.data).toMatchObject({ organization_id: ORG, cpf_available: true, address: ADDRESS_TEXT });
    expect(body.data).not.toHaveProperty("cpf");
    expect(body.data).not.toHaveProperty("address_structured");
    expect(JSON.stringify(body)).not.toContain(row.cpf_encrypted);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("agenda recebe a organização e o vínculo sem exigir o novo escopo", async () => {
    const appointmentId = "44444444-4444-4444-8444-444444444444";
    mocked.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes: [READ] });
    mocked.validate.mockResolvedValueOnce({ organizationId: ORG, role: "agent", scopes: ["agenda:read"] });
    mocked.rows = [{ data: row, error: null }, { data: { id: appointmentId, title: "Consulta", notes: null, event_type_id: null, owner_user_id: null }, error: null }];
    const response = await GET(new Request(`https://example.test/api/v1/prontuario/contacts/${ID}?appointment_id=${appointmentId}`, {
      headers: { authorization: "Bearer fixture-only", "x-agenda-authorization": "Bearer agenda-fixture-only" },
    }), { params: Promise.resolve({ id: ID }) });
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data).toMatchObject({ id: ID, organization_id: ORG, appointment: { id: appointmentId } });
    expect(data).not.toHaveProperty("cpf");
    expect(data).not.toHaveProperty("address_structured");
    expect(mocked.rpc).not.toHaveBeenCalled();
    expect(mocked.filters).toContainEqual(["contact_id", ID]);
    expect(mocked.validate).toHaveBeenNthCalledWith(2, "Bearer agenda-fixture-only");
  });

  it("verifica tenant e contato ativo antes da decifra e audita sem valores pessoais", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).data).toMatchObject({ organization_id: ORG, cpf: CPF, cpf_available: true, address: ADDRESS_TEXT, address_structured: ADDRESS });
    expect(mocked.rpc).toHaveBeenCalledExactlyOnceWith("decrypt_cpf", { p_contact_id: ID });
    expect(mocked.from).toHaveBeenCalledTimes(2);
    for (const filter of [["organization_id", ORG], ["id", ID], ["is_anonymized", false], ["is_merged_into", null]])
      expect(mocked.filters.filter(value => JSON.stringify(value) === JSON.stringify(filter))).toHaveLength(2);
    expect(mocked.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "contact.cpf_viewed", actorApiTokenId: TOKEN, organizationId: ORG, resourceId: ID, metadata: { decrypt_purpose: "prontuario_demographics_sync", success: true } }));
    for (const value of [CPF, ADDRESS_TEXT, row.cpf_encrypted, row.email, row.phone_number])
      expect(JSON.stringify(mocked.audit.mock.calls)).not.toContain(value);
  });

  it("demografia nunca usa o apelido no lugar do nome cadastral", async () => {
    const contact = { ...row, name: null, display_name: "Apelido WhatsApp" };
    mocked.rows = [{ data: contact, error: null }, { data: contact, error: null }];
    expect((await (await request()).json()).data.name).toBe("");
    mocked.rows = [{ data: contact, error: null }];
    expect((await (await request("")).json()).data.name).toBe("Apelido WhatsApp");
  });

  it("demografia remove somente espaços externos do nome cadastral", async () => {
    const contact = { ...row, name: "  Nome Cadastral  ", display_name: "Apelido WhatsApp" };
    mocked.rows = [{ data: contact, error: null }, { data: contact, error: null }];
    expect((await (await request()).json()).data.name).toBe("Nome Cadastral");
  });

  it("demografia ignora identificador técnico legado sem usar o apelido", async () => {
    const contact = { ...row, name: "Contato 543134@lid", display_name: "Apelido WhatsApp" };
    mocked.rows = [{ data: contact, error: null }, { data: contact, error: null }];
    expect((await (await request()).json()).data.name).toBe("");
  });

  it("a inclusão preserva os detalhes da agenda e exige a credencial separada", async () => {
    const appointmentId = "44444444-4444-4444-8444-444444444444";
    mocked.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes: [READ, DEMOGRAPHICS] });
    mocked.validate.mockResolvedValueOnce({ organizationId: ORG, role: "agent", scopes: ["agenda:read"] });
    mocked.rows = [{ data: row, error: null }, { data: { id: appointmentId, title: "Consulta", notes: "Nota fictícia", event_type_id: null, owner_user_id: null }, error: null }, { data: row, error: null }];
    const response = await GET(new Request(`https://example.test/api/v1/prontuario/contacts/${ID}?include=demographics&appointment_id=${appointmentId}`, {
      headers: { authorization: "Bearer fixture-only", "x-agenda-authorization": "Bearer agenda-fixture-only" },
    }), { params: Promise.resolve({ id: ID }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ cpf: CPF, appointment: { id: appointmentId, title: "Consulta", notes: "Nota fictícia", type: null, professional: null } });
    expect(mocked.validate).toHaveBeenNthCalledWith(2, "Bearer agenda-fixture-only");
    expect(mocked.filters).toContainEqual(["contact_id", ID]);
  });

  it("contato ausente, de outro tenant ou inativo não chega à decifra", async () => {
    mocked.rows = [{ data: null, error: null }];
    const response = await request();
    expect(response.status).toBe(404);
    expect(mocked.filters).toContainEqual(["organization_id", ORG]);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("contato sem CPF retorna null sem tentar decifrar", async () => {
    const noCpf = { ...row, cpf_encrypted: null };
    mocked.rows = [{ data: noCpf, error: null }, { data: noCpf, error: null }];
    expect((await (await request()).json()).data).toMatchObject({ cpf: null, cpf_available: false });
    expect(mocked.rpc).not.toHaveBeenCalled();
    expect(mocked.audit).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: "private database error" } },
    { data: null, error: null },
    { data: "11111111111", error: null },
    { data: "not a CPF", error: null },
  ])("falha fechada se a decifra falhar ou retornar CPF inválido", async result => {
    mocked.rpc.mockResolvedValueOnce(result);
    const response = await request();
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("private database error");
    expect(body).not.toContain(CPF);
    expect(body).not.toContain(row.cpf_encrypted);
    expect(body).not.toContain(ADDRESS_TEXT);
    expect(mocked.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { decrypt_purpose: "prontuario_demographics_sync", success: false } }));
  });

  it.each([
    { ...row, updated_at: "2026-10-02T00:00:00Z" },
    { ...row, cpf_encrypted: "other-cipher" },
    null,
  ])("não exporta snapshot misturado ou removido durante a leitura", async changed => {
    mocked.rows[1] = { data: changed, error: null };
    const response = await request();
    expect(response.status).toBe(409);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(CPF);
    expect(body).not.toContain(ADDRESS_TEXT);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    { endereco: "Endereço livre legado" },
    { endereco: "Texto alterado no CRM", endereco_estruturado: ADDRESS },
    { endereco: ADDRESS_TEXT, endereco_estruturado: { ...ADDRESS, uf: "XX" } },
    { endereco: ADDRESS_TEXT, endereco_estruturado: { ...ADDRESS, extra: "não permitido" } },
  ])("preserva texto autoritativo e não reaproveita estrutura ausente, inválida ou velha", async fields => {
    const contact = { ...row, custom_fields: fields };
    mocked.rows = [{ data: contact, error: null }, { data: contact, error: null }];
    const body = await (await request()).json();
    expect(body.data.address).toBe(fields.endereco);
    expect(body.data.address_structured).toBeNull();
  });

  it("preenche componentes opcionais vazios somente para estrutura coerente", async () => {
    const contact = { ...row, custom_fields: { endereco: "Vitória, ES", endereco_estruturado: { cidade: "Vitória", uf: "ES" } } };
    mocked.rows = [{ data: contact, error: null }, { data: contact, error: null }];
    expect((await (await request()).json()).data.address_structured).toEqual({ cep: "", logradouro: "", numero: "", complemento: "", bairro: "", cidade: "Vitória", uf: "ES" });
  });

  it("limitação e falhas de banco não expõem dados", async () => {
    mocked.rate.mockResolvedValueOnce({ allowed: false });
    expect((await request()).status).toBe(429);
    expect(mocked.from).not.toHaveBeenCalled();
    mocked.rows = [{ data: null, error: { message: "db" } }];
    expect((await request()).status).toBe(503);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
});
