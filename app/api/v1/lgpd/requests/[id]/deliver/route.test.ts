// @vitest-environment node
/**
 * POST /api/v1/lgpd/requests/[id]/deliver: "Marcar como entregue".
 *
 * O pedido em "Revisão pendente" tem o relatório pronto e ninguém para quem o
 * sistema consiga mandar. A equipe entrega à mão e fecha o pedido aqui; sem isto
 * o alarme de prazo toca para sempre (o vigia só ignora `completed` e `failed`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as EmMemoria from "@/tests/helpers/supabase-em-memoria";
import { supabaseEmMemoria, type Linha } from "@/tests/helpers/supabase-em-memoria";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  erro: vi.fn(),
  banco: null as unknown as ReturnType<typeof EmMemoria.supabaseEmMemoria>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: h.erro, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));

import { POST } from "@/app/api/v1/lgpd/requests/[id]/deliver/route";

const ORG = "b1000000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b2000000-0000-4000-8000-000000000002";
const USER = "b1000000-0000-4000-8000-000000000003";
const PEDIDO = "b1000000-0000-4000-8000-000000000004";
const AGORA = new Date("2026-10-12T18:00:00Z");

function chamar(corpo: unknown, id = PEDIDO) {
  const r = new NextRequest(`http://localhost/api/v1/lgpd/requests/${id}/deliver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return POST(r, { params: Promise.resolve({ id }) });
}
const pedido = () => (h.banco.tabelas.lgpd_requests as Linha[])[0]!;

function montar(troca: Linha = {}) {
  h.banco = supabaseEmMemoria({
    lgpd_requests: [
      {
        id: PEDIDO,
        organization_id: ORG,
        request_type: "data_request",
        status: "pending_review",
        error_message: "no_delivery_email",
        completed_at: null,
        result: { pdf_path: `${ORG}/${PEDIDO}/report.pdf` },
        ...troca,
      },
    ],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: AGORA, toFake: ["Date"] });
  montar();
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "admin" } });
  h.apoio.mockResolvedValue(null);
});

describe("marcar como entregue", () => {
  it("fecha o pedido: Concluído, com quem, quando e como, e o relatório continua apontado", async () => {
    const r = await chamar({ method: "presencial", note: "Retirou na recepção com documento." });
    expect(r.status).toBe(200);
    expect(pedido()).toMatchObject({
      status: "completed",
      completed_at: AGORA.toISOString(),
      error_message: null,
      result: {
        pdf_path: `${ORG}/${PEDIDO}/report.pdf`,
        manual_delivery: {
          by: USER,
          at: AGORA.toISOString(),
          method: "presencial",
          note: "Retirou na recepção com documento.",
        },
      },
    });
  });

  it("audita lgpd.export_delivered com o ator e a forma, sem a observação", async () => {
    await chamar({ method: "whatsapp", note: "Enviado ao número do cadastro." });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const entrada = h.audit.mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "lgpd.export_delivered",
      actorUserId: USER,
      organizationId: ORG,
      resourceType: "lgpd_request",
      resourceId: PEDIDO,
      metadata: { delivery: "manual", method: "whatsapp" },
    });
    expect(JSON.stringify(entrada)).not.toMatch(/cadastro/);
  });

  it("exige administrador", async () => {
    h.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await chamar({ method: "presencial" })).status).toBe(403);
    expect(h.guard).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "lgpd_requests" }));
    expect(pedido().status).toBe("pending_review");
  });

  it("forma de entrega fora do vocabulário é 422", async () => {
    expect((await chamar({ method: "pombo" })).status).toBe(422);
    expect(pedido().status).toBe("pending_review");
  });

  it("pedido de outra organização é 404 e fica como estava", async () => {
    montar({ organization_id: OUTRA_ORG });
    expect((await chamar({ method: "presencial" })).status).toBe(404);
    expect(pedido().status).toBe("pending_review");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each(["received", "processing", "completed", "failed"])("pedido em %s não pode ser marcado (409)", async (status) => {
    montar({ status });
    const r = await chamar({ method: "presencial" });
    expect(r.status).toBe(409);
    expect(pedido().status).toBe(status);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("pedido de anonimização em revisão pendente não é uma entrega (409)", async () => {
    montar({ request_type: "redact", error_message: "no_local_footprint" });
    expect((await chamar({ method: "presencial" })).status).toBe(409);
    expect(pedido().status).toBe("pending_review");
  });

  it("se o banco recusar a gravação, falha em voz alta: 500, erro no log e nada auditado", async () => {
    h.banco.recusar.lgpd_requests = { code: "23514", message: "check" };
    const r = await chamar({ method: "presencial" });
    expect(r.status).toBe(500);
    expect(h.erro).toHaveBeenCalledTimes(1);
    expect(h.audit).not.toHaveBeenCalled();
    expect(pedido().status).toBe("pending_review");
  });
});
