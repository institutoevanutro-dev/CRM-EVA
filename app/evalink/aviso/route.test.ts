// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { aplicarAviso } from "@/lib/evalink/entrada";
import { cabecalhoDeAviso } from "@/lib/evalink/aviso";

const SEGREDO = "segredo-de-teste-com-tamanho-suficiente-000";
vi.mock("@/lib/evalink/config", () => ({ configEvalink: () => ({ segredoAviso: "segredo-de-teste-com-tamanho-suficiente-000" }) }));
vi.mock("@/lib/evalink/entrada", () => ({ aplicarAviso: vi.fn() }));
vi.mock("@/lib/evalink/sessao", () => ({ origemDaRequisicao: () => ({}) }));
vi.mock("@/lib/auth/rate-limit", () => ({ AUTH_LIMITS: {}, authRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { POST } from "./route";

const U = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";
const SUB = "33333333-3333-4333-8333-333333333333";

function pedido(corpo: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://interno:3000/evalink/aviso", {
    method: "POST",
    body: corpo,
    headers: { "x-evalink-assinatura": cabecalhoDeAviso(SEGREDO, corpo, ID), ...headers },
  });
}

describe("POST /evalink/aviso", () => {
  beforeEach(() => {
    vi.mocked(audit).mockClear();
    vi.mocked(aplicarAviso).mockReset();
  });

  it("aviso novo: audita com resourceType user e o id afetado", async () => {
    vi.mocked(aplicarAviso).mockResolvedValue({ resultado: "feito", userId: U, banido: false });
    const corpo = JSON.stringify({ id: ID, sub: SUB, motivo: "desligado", modulo: "crm" });
    const r = await POST(pedido(corpo));
    expect(r.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.evalink_aviso", resourceType: "user", resourceId: U,
      metadata: { motivo: "desligado", banido: false },
    }));
  });

  it("aviso repetido: 200 sem segunda linha de auditoria", async () => {
    vi.mocked(aplicarAviso).mockResolvedValue({ resultado: "repetido", userId: null, banido: false });
    const corpo = JSON.stringify({ id: ID, sub: SUB, motivo: "desligado", modulo: "crm" });
    expect((await POST(pedido(corpo))).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("content-length acima de 16 KB: 413 sem tocar no aviso", async () => {
    const r = await POST(pedido("{}", { "content-length": String(16 * 1024 + 1) }));
    expect(r.status).toBe(413);
    expect(aplicarAviso).not.toHaveBeenCalled();
  });

  it("corpo lido acima de 16 KB, sem content-length: 413", async () => {
    const corpo = JSON.stringify({ id: ID, sub: SUB, motivo: "desligado", modulo: "x".repeat(17 * 1024) });
    const r = await POST(pedido(corpo));
    expect(r.status).toBe(413);
    expect(aplicarAviso).not.toHaveBeenCalled();
  });
});
