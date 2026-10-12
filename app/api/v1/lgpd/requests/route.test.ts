// @vitest-environment node
/**
 * POST /api/v1/lgpd/requests: a equipe registra o pedido que o titular fez por
 * WhatsApp, e-mail, telefone ou no balcão.
 *
 * O banco é de mentira mas FILTRA de verdade (`tests/helpers/supabase-em-memoria`),
 * e o repositório, o esquema e a idempotência são os reais.
 *
 * O caso que mais importa é o último bloco: registrar um pedido de anonimização
 * NÃO emite evento nenhum. Quem emite é a aprovação. O worker de anonimização
 * executa ao receber `lgpd.redact_received` sem olhar o estado do pedido, então
 * um evento emitido aqui apagaria o paciente no minuto seguinte, sem ninguém aprovar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { supabaseEmMemoria, type Linha } from "@/tests/helpers/supabase-em-memoria";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  banco: null as unknown as ReturnType<typeof import("@/tests/helpers/supabase-em-memoria").supabaseEmMemoria>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.cliente }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));

import { POST } from "@/app/api/v1/lgpd/requests/route";

const ORG = "a1000000-0000-4000-8000-000000000001";
const OUTRA_ORG = "a2000000-0000-4000-8000-000000000002";
const USER = "a1000000-0000-4000-8000-000000000003";
const CONTATO = "a1000000-0000-4000-8000-000000000004";
const CONTATO_DA_OUTRA = "a2000000-0000-4000-8000-000000000005";
const CHAVE = "a1000000-0000-4000-8000-000000000006";
// Segunda-feira, 12/10/2026 (feriado), 15h no Brasil.
const AGORA = new Date("2026-10-12T18:00:00Z");

const CORPO = {
  contact_id: CONTATO,
  request_type: "data_request",
  channel: "whatsapp",
  received_on: "2026-10-09",
  delivery_email: "Paciente@Exemplo.com",
  note: "Pediu pelo WhatsApp da recepção.",
};

function req(corpo: unknown, chave?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (chave) headers["Idempotency-Key"] = chave;
  return new NextRequest("http://localhost/api/v1/lgpd/requests", {
    method: "POST",
    headers,
    body: JSON.stringify(corpo),
  });
}
const pedidos = () => h.banco.tabelas.lgpd_requests as Linha[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: AGORA, toFake: ["Date"] });
  h.banco = supabaseEmMemoria({
    contacts: [
      { id: CONTATO, organization_id: ORG, is_anonymized: false },
      { id: CONTATO_DA_OUTRA, organization_id: OUTRA_ORG, is_anonymized: false },
    ],
    lgpd_requests: [],
    idempotency_keys: [],
  });
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "admin" } });
  h.apoio.mockResolvedValue(null);
});

describe("quem pode", () => {
  it("exige administrador, e devolve a recusa do guarda sem tocar o banco", async () => {
    h.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const r = await POST(req(CORPO));
    expect(r.status).toBe(403);
    expect(h.guard).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "lgpd_requests" }));
    expect(pedidos()).toHaveLength(0);
  });

  it("sessão de suporte somente leitura não registra", async () => {
    h.apoio.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(req(CORPO))).status).toBe(403);
    expect(pedidos()).toHaveLength(0);
  });
});

describe("o que entra", () => {
  it.each([
    ["sem contato", { contact_id: undefined }],
    ["tipo fora do vocabulário", { request_type: "store_redact" }],
    ["canal desconhecido", { channel: "fax" }],
    ["data que não existe", { received_on: "2026-02-31" }],
    ["e-mail torto", { delivery_email: "nao-e-email" }],
  ])("recusa %s com 422", async (_nome, troca) => {
    const r = await POST(req({ ...CORPO, ...troca }));
    expect(r.status).toBe(422);
    expect(pedidos()).toHaveLength(0);
  });

  it("recusa data de recebimento no futuro", async () => {
    const r = await POST(req({ ...CORPO, received_on: "2026-10-13" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toMatch(/futuro/);
    expect(pedidos()).toHaveLength(0);
  });

  it("hoje é o dia do Brasil: às 22h de Brasília o dia de hoje ainda vale", async () => {
    vi.setSystemTime(new Date("2026-10-13T01:00:00Z")); // 22h do dia 12 no Brasil
    expect((await POST(req({ ...CORPO, received_on: "2026-10-12" }))).status).toBe(201);
    expect((await POST(req({ ...CORPO, received_on: "2026-10-13", request_type: "redact" }))).status).toBe(422);
  });

  it("Idempotency-Key que não é UUID é recusada antes de qualquer efeito", async () => {
    expect((await POST(req(CORPO, "abc"))).status).toBe(400);
    expect(pedidos()).toHaveLength(0);
  });
});

describe("o que grava", () => {
  it("cria o pedido na organização da SESSÃO, com o prazo contado do dia em que o titular pediu", async () => {
    const r = await POST(req({ ...CORPO, organization_id: OUTRA_ORG }));
    expect(r.status).toBe(201);
    const corpo = (await r.json()).data;
    expect(pedidos()).toHaveLength(1);
    expect(pedidos()[0]).toMatchObject({
      organization_id: ORG,
      contact_id: CONTATO,
      request_type: "data_request",
      source: "manual",
      status: "received",
      received_at: "2026-10-09T12:00:00.000Z",
      // Sexta 09/10 + 7 dias úteis, pulando o feriado de 12/10: 21/10.
      due_at: "2026-10-21T00:00:00.000Z",
      request_payload: {
        channel: "whatsapp",
        note: "Pediu pelo WhatsApp da recepção.",
        delivery: { method: "email", address: "paciente@exemplo.com" },
        registered_by: USER,
      },
    });
    expect(corpo).toMatchObject({ id: pedidos()[0]!.id, status: "received", due_at: "2026-10-21T00:00:00.000Z" });
  });

  it("anonimização tem 15 dias úteis, e sem e-mail o pedido nasce sem endereço de entrega", async () => {
    const r = await POST(req({ ...CORPO, request_type: "redact", delivery_email: null }));
    expect(r.status).toBe(201);
    expect(pedidos()[0]).toMatchObject({ request_type: "redact", due_at: "2026-11-03T00:00:00.000Z" });
    expect((pedidos()[0]!.request_payload as Linha).delivery).toBeNull();
  });

  it("audita lgpd.data_request_received com ator e canal, e sem dado pessoal", async () => {
    await POST(req(CORPO));
    expect(h.audit).toHaveBeenCalledTimes(1);
    const entrada = h.audit.mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "lgpd.data_request_received",
      actorUserId: USER,
      organizationId: ORG,
      resourceType: "lgpd_request",
      resourceId: pedidos()[0]!.id,
      metadata: { source: "manual", channel: "whatsapp", contact_id: CONTATO, delivery_method: "email" },
    });
    const texto = JSON.stringify(entrada);
    expect(texto).not.toMatch(/exemplo\.com/i);
    expect(texto).not.toMatch(/recepção/);
  });

  it("pedido de anonimização audita lgpd.redact_received", async () => {
    await POST(req({ ...CORPO, request_type: "redact" }));
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "lgpd.redact_received" });
  });

  it("falha do banco não audita nem devolve 201", async () => {
    h.banco.recusar.lgpd_requests = { code: "23514", message: "check" };
    expect((await POST(req(CORPO))).status).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("isolamento entre organizações", () => {
  it("contato de outra organização é 404, e nada é criado", async () => {
    const r = await POST(req({ ...CORPO, contact_id: CONTATO_DA_OUTRA }));
    expect(r.status).toBe(404);
    expect(pedidos()).toHaveLength(0);
  });

  it("pedido aberto do mesmo contato em OUTRA organização não conta como duplicata", async () => {
    pedidos().push({ id: "x", organization_id: OUTRA_ORG, contact_id: CONTATO, request_type: "data_request", status: "received" });
    expect((await POST(req(CORPO))).status).toBe(201);
  });
});

describe("duplicata", () => {
  it.each(["received", "processing", "pending_review"])(
    "recusa com 409 quando já há pedido %s do mesmo tipo para o contato, e diz qual",
    async (status) => {
      pedidos().push({ id: "ja-existe", organization_id: ORG, contact_id: CONTATO, request_type: "data_request", status });
      const r = await POST(req(CORPO));
      expect(r.status).toBe(409);
      const erro = (await r.json()).error;
      expect(erro.code).toBe("state_conflict");
      expect(erro.details).toMatchObject({ existing_request_id: "ja-existe" });
      expect(pedidos()).toHaveLength(1);
    },
  );

  it.each(["completed", "failed"])("pedido %s não impede um novo", async (status) => {
    pedidos().push({ id: "antigo", organization_id: ORG, contact_id: CONTATO, request_type: "data_request", status });
    expect((await POST(req(CORPO))).status).toBe(201);
  });

  it("pedido aberto de OUTRO tipo não impede", async () => {
    pedidos().push({ id: "copia", organization_id: ORG, contact_id: CONTATO, request_type: "data_request", status: "received" });
    expect((await POST(req({ ...CORPO, request_type: "redact" }))).status).toBe(201);
  });

  it("contato já anonimizado não recebe pedido novo", async () => {
    (h.banco.tabelas.contacts![0] as Linha).is_anonymized = true;
    expect((await POST(req(CORPO))).status).toBe(422);
    expect(pedidos()).toHaveLength(0);
  });
});

describe("idempotência", () => {
  it("mesma chave e mesmo corpo criam UM pedido e auditam uma vez", async () => {
    const a = await POST(req(CORPO, CHAVE));
    const b = await POST(req(CORPO, CHAVE));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await b.json()).data.id).toBe((await a.json()).data.id);
    expect(pedidos()).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("mesma chave com outro corpo é 409 idempotency_conflict", async () => {
    await POST(req(CORPO, CHAVE));
    const r = await POST(req({ ...CORPO, channel: "email" }, CHAVE));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("idempotency_conflict");
  });
});

describe("registrar não executa nada", () => {
  it.each(["redact", "data_request"])(
    "pedido de %s nasce received e NENHUM evento é emitido: só a aprovação põe o worker para andar",
    async (request_type) => {
      const r = await POST(req({ ...CORPO, request_type }));
      expect(r.status).toBe(201);
      expect(pedidos()[0]).toMatchObject({ status: "received" });
      expect(h.banco.rpc).not.toHaveBeenCalled();
      expect(h.banco.tabelas.event_log ?? []).toHaveLength(0);
    },
  );
});
