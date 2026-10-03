import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ limit: vi.fn(async () => ({ allowed: false })), from: vi.fn(), audit: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: state.from }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "test-secret" }));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/webhooks/captacao", () => ({ registrarCaptacao: state.capture, origemDaPagina: () => null }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: state.limit }));
import { POST } from "@/app/api/v1/webhooks/in/[token]/route";
beforeEach(() => {
  vi.clearAllMocks();
  state.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
    id: "source", organization_id: "org", name: "Test", is_active: true, secret_encrypted: "ciphertext",
  }, error: null }) }) }) });
});
async function call(valid: boolean) {
  const body = JSON.stringify({ nome: "Synthetic" });
  return POST(new NextRequest("http://localhost/api/v1/webhooks/in/test-token", {
    method: "POST", body, headers: { "content-type": "application/json", "x-deskcomm-signature": valid ? createHmac("sha256", "test-secret").update(body).digest("hex") : "invalid" },
  }), { params: Promise.resolve({ token: "test-token" }) });
}
it("assinatura inválida não consome a cota da fonte", async () => {
  state.limit.mockResolvedValueOnce({ allowed: true });
  expect((await call(false)).status).toBe(401);
  expect(state.limit).toHaveBeenCalledExactlyOnceWith("webhook_in_recusa:test-token", 30, 60);
  expect(state.audit).toHaveBeenCalledOnce();
  expect(state.capture).toHaveBeenCalledOnce();
});
it("recusa acima do teto continua 401, mas não grava auditoria nem captação", async () => {
  expect((await call(false)).status).toBe(401);
  expect(state.audit).not.toHaveBeenCalled();
  expect(state.capture).not.toHaveBeenCalled();
});
it("assinatura válida continua sujeita à cota", async () => {
  expect((await call(true)).status).toBe(429);
  expect(state.limit).toHaveBeenCalledExactlyOnceWith("webhook_in:test-token", 60, 60);
});
