import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuthError } from "@/lib/mcp/auth";

const m = vi.hoisted(() => ({ validate: vi.fn(), rate: vi.fn(), listar: vi.fn(), leitura: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (original) => ({ ...(await original<typeof import("@/lib/mcp/auth")>()), validateBearerToken: m.validate }));
vi.mock("@/lib/audit/leitura", () => ({ auditarLeitura: m.leitura }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: m.rate }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/prontuario/midias", async (original) => ({
  ...(await original<typeof import("@/lib/prontuario/midias")>()),
  listarMidiasDoContato: m.listar,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const ESCOPO = "prontuario:media:read";
const linha = {
  message_id: MSG, contact_id: ID, conversation_id: "c", sent_at: new Date("2026-11-01T10:00:00.000Z"),
  mime: "application/pdf", size_bytes: "2048", filename: "exame-ficticio.pdf", type: "document",
  storage_path: `${ORG}/c/${MSG}.pdf`, pendente: false,
};

const { GET } = await import("./route");
const pedir = (query = "", id = ID) =>
  GET(new Request(`https://example.test/api/v1/prontuario/contacts/${id}/midias${query}`, { headers: { authorization: "Bearer fixture-only" } }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.validate.mockResolvedValue({ organizationId: ORG, apiTokenId: TOKEN, scopes: [ESCOPO] });
  m.rate.mockResolvedValue({ allowed: true });
  m.listar.mockResolvedValue([linha]);
});

describe("GET /api/v1/prontuario/contacts/{id}/midias", () => {
  it("sem o escopo → 403 \"Credencial sem acesso.\" e nada consultado", async () => {
    for (const scopes of [["prontuario:contacts:read"], ["mcp:read"], []]) {
      m.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes });
      const r = await pedir();
      expect(r.status).toBe(403);
      expect((await r.json()).error.message).toBe("Credencial sem acesso.");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    m.validate.mockRejectedValueOnce(new McpAuthError(-32001, 401, "Revogado"));
    expect((await pedir()).status).toBe(401);
    expect(m.listar).not.toHaveBeenCalled();
  });

  it("id malformado → 404 (não 422)", async () => {
    expect((await pedir("", "nao-e-uuid")).status).toBe(404);
    expect(m.listar).not.toHaveBeenCalled();
  });

  it("dias 0, 181, texto e repetido → 422 sem consulta", async () => {
    for (const q of ["?dias=0", "?dias=181", "?dias=abc", "?dias=60&dias=90"]) {
      const r = await pedir(q);
      expect(r.status, q).toBe(422);
      expect((await r.json()).error.message).toBe("Período inválido.");
    }
    expect(m.listar).not.toHaveBeenCalled();
  });

  it("padrão 60 dias; organização = a do TOKEN; item só com os seis campos", async () => {
    const r = await pedir();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(m.listar).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, contactId: ID, dias: 60 });
    const { data } = await r.json();
    expect(data).toEqual([
      { message_id: MSG, received_at: "2026-11-01T10:00:00.000Z", mime: "application/pdf", size_bytes: 2048, filename: "exame-ficticio.pdf", kind: "documento" },
    ]);
    await pedir("?dias=90");
    expect(m.listar).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ dias: 90 }));
  });

  it("auditoria literal: ids, quantidade, dias — nunca nome nem mime", async () => {
    await pedir();
    expect(m.leitura).toHaveBeenCalledWith(expect.objectContaining({
      action: "prontuario.media_listed", actorApiTokenId: TOKEN, organizationId: ORG, resourceType: "contact", resourceId: ID,
      metadata: { quantidade: 1, dias: 60, ids: [MSG] },
    }));
    expect(JSON.stringify(m.leitura.mock.calls)).not.toContain("exame-ficticio");
  });

  it("limite por chave → 429 com Retry-After", async () => {
    m.rate.mockResolvedValueOnce({ allowed: false });
    const r = await pedir();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(m.rate).toHaveBeenCalledWith(`prontuario-media-list:${ORG}:${TOKEN}`, 60, 60);
  });

  it("pool falha → 503", async () => {
    m.listar.mockRejectedValueOnce(new Error("SUPABASE_DB_URL ausente"));
    expect((await pedir()).status).toBe(503);
  });
});
