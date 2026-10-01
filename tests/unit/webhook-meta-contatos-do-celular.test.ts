import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "222" };
const SEGREDO = "segredo-de-teste";
let rpcs: Array<{ fn: string; args: Record<string, unknown> }>;

vi.mock("@/lib/channels/meta/session", () => ({ metaSessionByWebhookToken: async () => SESSAO }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => (rpcs.push({ fn, args }), { data: null, error: null }),
  }),
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

function entrega(corpo: unknown) {
  const cru = JSON.stringify(corpo);
  return {
    text: async () => cru,
    headers: new Headers({ "x-hub-signature-256": `sha256=${createHmac("sha256", SEGREDO).update(cru, "utf8").digest("hex")}` }),
  } as never;
}
const ctx = { params: Promise.resolve({ token: "t" }) } as never;

beforeEach(() => {
  rpcs = [];
  vi.stubEnv("META_APP_SECRET", SEGREDO);
});

describe("webhook da Meta: contatos do celular", () => {
  it("smb_app_state_sync com 2 contatos → enfileirado em event_log, nada aplicado na hora", async () => {
    const corpo = {
      object: "whatsapp_business_account",
      entry: [{ id: "222", changes: [{ field: "smb_app_state_sync", value: {
        messaging_product: "whatsapp",
        metadata: { phone_number_id: "111" },
        state_sync: [
          { type: "contact", action: "add", contact: { full_name: "Maria", phone_number: "5511999998888" } },
          { type: "contact", action: "add", contact: { full_name: "João", phone_number: "5511988887777" } },
        ],
      } }] }],
    };
    const res = await POST(entrega(corpo), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcomes: ["contatos:enfileirado"] });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({
      fn: "emit_event",
      args: {
        p_event_type: "meta.state_sync", p_entity_kind: "channel_session", p_entity_id: "sess-1", p_organization_id: "org-1",
        p_payload: { phone_number_id: "111", contatos: [{ waId: "5511999998888", nome: "Maria" }, { waId: "5511988887777", nome: "João" }] },
      },
    });
  });
});
