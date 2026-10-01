import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "222" };
const SEGREDO = "segredo-de-teste";
let updates: Array<Record<string, unknown>>;

vi.mock("@/lib/channels/meta/session", () => ({ metaSessionByWebhookToken: async () => SESSAO }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: (set: Record<string, unknown>) => {
        updates.push(set);
        const q: Record<string, unknown> = {};
        for (const m of ["eq", "is", "in", "or"]) q[m] = () => q;
        q.select = async () => ({ data: [{ id: "c" }], error: null });
        return q;
      },
    }),
    rpc: async () => ({ data: null, error: null }),
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
  updates = [];
  vi.stubEnv("META_APP_SECRET", SEGREDO);
});

describe("webhook da Meta: contatos do celular", () => {
  it("smb_app_state_sync com 2 contatos → contatos:2", async () => {
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
    expect(await res.json()).toMatchObject({ outcomes: ["contatos:2"] });
    expect(updates).toEqual([{ display_name: "Maria" }, { display_name: "João" }]);
  });
});
