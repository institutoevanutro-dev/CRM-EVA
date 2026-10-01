import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Rota: account_update chega ao handler de saúde da conta e a Meta recebe 200. */
const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "222" };
const SEGREDO = "segredo-de-teste";
const aplicar = vi.fn(async () => "caiu");

vi.mock("@/lib/channels/meta/session", () => ({ metaSessionByWebhookToken: async () => SESSAO }));
vi.mock("@/lib/channels/meta/saude-da-conta", () => ({ aplicarEventoDaConta: (...a: unknown[]) => aplicar(...(a as [])) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

function entrega(field: string, value: Record<string, unknown>) {
  const cru = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "222", changes: [{ field, value }] }] });
  return {
    text: async () => cru,
    headers: new Headers({ "x-hub-signature-256": `sha256=${createHmac("sha256", SEGREDO).update(cru, "utf8").digest("hex")}` }),
  } as never;
}
const ctx = { params: Promise.resolve({ token: "t" }) } as never;

beforeEach(() => {
  aplicar.mockClear();
  vi.stubEnv("META_APP_SECRET", SEGREDO);
});

describe("webhook da Meta: eventos da conta", () => {
  it("account_update PARTNER_REMOVED chega ao handler e a rota responde 200", async () => {
    const res = await POST(entrega("account_update", { event: "PARTNER_REMOVED", disconnection_info: { reason: "USER_INITIATED_DISCONNECT" } }), ctx);
    expect(res.status).toBe(200);
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(aplicar.mock.calls[0]![2]).toMatchObject({ kind: "account_event", evento: "PARTNER_REMOVED", motivo: "USER_INITIATED_DISCONNECT" });
  });
  it("account_reconnected (campo próprio) também chega", async () => {
    const res = await POST(entrega("account_reconnected", {}), ctx);
    expect(res.status).toBe(200);
    expect(aplicar.mock.calls[0]![2]).toMatchObject({ evento: "ACCOUNT_RECONNECTED" });
  });
});
