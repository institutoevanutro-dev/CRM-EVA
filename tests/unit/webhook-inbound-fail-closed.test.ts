import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  decrypt: vi.fn(),
  from: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: state.from }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: state.decrypt }));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/webhooks/captacao", () => ({ registrarCaptacao: state.capture, origemDaPagina: () => null }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

beforeEach(() => {
  vi.clearAllMocks();
  state.from.mockImplementation((table: string) => {
    if (table !== "webhook_sources") throw new Error(`Unexpected write: ${table}`);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { id: "source", organization_id: "org", name: "Test", is_active: true, secret_encrypted: "\\xabcd" },
      error: null,
    }) }) }) };
  });
});

it.each([null, ""])("recusa segredo configurado indisponível (%s) antes de criar ou arquivar lead", async (secret) => {
  state.decrypt.mockResolvedValue(secret);
  const response = await POST(new NextRequest("http://localhost/api/v1/webhooks/in/test-token", {
    method: "POST", body: JSON.stringify({ nome: "Synthetic test" }),
    headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ token: "test-token" }) });
  expect(response.status).toBe(503);
  expect(state.from.mock.calls.map(([table]) => table)).toEqual(["webhook_sources"]);
  expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "webhook.inbound_secret_unavailable" }));
  expect(state.capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "recusado", rejectReason: "segredo_indisponivel" }));
});
