import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ validate: vi.fn(), rate: vi.fn(), buscar: vi.fn(), leitura: vi.fn(), download: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (original) => ({ ...(await original<typeof import("@/lib/mcp/auth")>()), validateBearerToken: m.validate }));
vi.mock("@/lib/audit/leitura", () => ({ auditarLeitura: m.leitura }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: m.rate }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: m.warn, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: { from: () => ({ download: m.download }) } }) }));
vi.mock("@/lib/prontuario/midias", async (original) => ({
  ...(await original<typeof import("@/lib/prontuario/midias")>()),
  buscarMidia: m.buscar,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "55555555-5555-4555-8555-555555555555";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const BYTES = new TextEncoder().encode("%PDF-1.4 ficticio");
const midia = (p: Record<string, unknown> = {}) => ({
  message_id: MSG, contact_id: CONTATO, conversation_id: CONV, sent_at: new Date(), mime: "application/pdf",
  size_bytes: String(BYTES.byteLength), filename: "exame-ficticio.pdf", type: "document",
  storage_path: `${ORG}/${CONV}/${MSG}.pdf`, pendente: false, ...p,
});

const { GET } = await import("./route");
const pedir = (id = MSG) =>
  GET(new Request(`https://example.test/api/v1/prontuario/midias/${id}`, { headers: { authorization: "Bearer fixture-only" } }), {
    params: Promise.resolve({ id }),
  });

let corpoDo404 = "";
beforeEach(async () => {
  vi.clearAllMocks();
  m.validate.mockResolvedValue({ organizationId: ORG, apiTokenId: TOKEN, scopes: ["prontuario:media:read"] });
  m.rate.mockResolvedValue({ allowed: true });
  m.buscar.mockResolvedValue(midia());
  m.download.mockResolvedValue({ data: new Blob([BYTES]), error: null });
  if (!corpoDo404) {
    m.buscar.mockResolvedValueOnce(null);
    corpoDo404 = JSON.stringify((await (await pedir()).json()).error);
  }
});

async function erroDe(r: Response) {
  return JSON.stringify((await r.json()).error);
}

describe("GET /api/v1/prontuario/midias/{id}", () => {
  it("busca a mídia na organização da CHAVE", async () => {
    await pedir();
    expect(m.buscar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG }));
  });

  it("sem escopo → 403; id malformado → 404", async () => {
    m.validate.mockResolvedValueOnce({ organizationId: ORG, apiTokenId: TOKEN, scopes: ["prontuario:contacts:read"] });
    expect((await pedir()).status).toBe(403);
    const r = await pedir("x");
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toBe(corpoDo404);
  });

  it("o mesmo 404 para inexistente, webp, heic, caminho fora da mensagem e arquivo ausente no Storage", async () => {
    const casos: Array<() => void> = [
      () => m.buscar.mockResolvedValueOnce(null),
      () => m.buscar.mockResolvedValueOnce(midia({ mime: "image/webp" })),
      () => m.buscar.mockResolvedValueOnce(midia({ mime: "image/heic" })),
      () => m.buscar.mockResolvedValueOnce(midia({ storage_path: `outra-org/${CONV}/${MSG}.pdf` })),
      () => m.buscar.mockResolvedValueOnce(midia({ storage_path: `${ORG}/${CONV}/outro-arquivo.pdf` })),
      () => m.download.mockResolvedValueOnce({ data: null, error: { message: "Object not found" } }),
    ];
    for (const preparar of casos) {
      preparar();
      const r = await pedir();
      expect(r.status).toBe(404);
      expect(await erroDe(r)).toBe(corpoDo404);
    }
    expect(m.warn).toHaveBeenCalledWith("prontuario.midia.caminho_fora_da_mensagem", expect.objectContaining({ message_id: MSG }));
  });

  it("pendente → 409; acima de 15 MiB (linha ou bytes) → 413; Storage fora → 503", async () => {
    m.buscar.mockResolvedValueOnce(midia({ pendente: true, storage_path: null }));
    const pend = await pedir();
    expect(pend.status).toBe(409);
    expect((await pend.json()).error.code).toBe("midia_ainda_nao_disponivel");
    m.buscar.mockResolvedValueOnce(midia({ size_bytes: String(15 * 1024 * 1024 + 1) }));
    expect((await pedir()).status).toBe(413);
    m.download.mockResolvedValueOnce({ data: new Blob([new Uint8Array(15 * 1024 * 1024 + 1)]), error: null });
    expect((await pedir()).status).toBe(413);
    m.download.mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    expect((await pedir()).status).toBe(503);
  });

  it("200 com os bytes e os cabeçalhos exatos", async () => {
    const r = await pedir();
    expect(r.status).toBe(200);
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual(Array.from(BYTES));
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toBe("attachment");
    expect(r.headers.get("content-length")).toBe(String(BYTES.byteLength));
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-request-id")).toBeTruthy();
  });

  it("auditoria sem nome nem caminho", async () => {
    await pedir();
    expect(m.leitura).toHaveBeenCalledWith(expect.objectContaining({
      action: "prontuario.media_downloaded", resourceType: "message", resourceId: MSG,
      metadata: { mime: "application/pdf", size_bytes: BYTES.byteLength, contact_id: CONTATO },
    }));
    const trilha = JSON.stringify(m.leitura.mock.calls);
    expect(trilha).not.toContain("exame-ficticio");
    expect(trilha).not.toContain(".pdf");
  });

  it("bucket de rate limit próprio → 429 com Retry-After", async () => {
    m.rate.mockResolvedValueOnce({ allowed: false });
    const r = await pedir();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(m.rate).toHaveBeenCalledWith(`prontuario-media-get:${ORG}:${TOKEN}`, 60, 60);
  });
});
