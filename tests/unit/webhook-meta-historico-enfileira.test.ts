import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rota: o webhook `history` (coexistência) não grava nada na hora — o pedaço
 * cru vai para `event_log` como `meta.history_chunk`, com a sessão e a
 * organização do TOKEN, e o worker (`workers/meta-history-worker.ts`) importa.
 */
const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "222" };
const SEGREDO = "segredo-de-teste";
let rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
let erroRpc: { message: string } | null;

vi.mock("@/lib/channels/meta/session", () => ({ metaSessionByWebhookToken: async () => SESSAO }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { data: null, error: erroRpc };
    },
  }),
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

const F = JSON.parse(readFileSync("tests/fixtures/meta/coexistencia-webhooks.json", "utf8")) as unknown[];

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
  erroRpc = null;
  vi.stubEnv("META_APP_SECRET", SEGREDO);
});

describe("webhook da Meta: histórico do celular", () => {
  it("history vira meta.history_chunk na fila, com a sessão do token e o value cru", async () => {
    const res = await POST(entrega(F[1]), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcomes: ["history:enfileirado"] });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({
      fn: "emit_event",
      args: {
        p_event_type: "meta.history_chunk", p_entity_kind: "channel_session", p_entity_id: "sess-1", p_organization_id: "org-1",
        p_payload: { phone_number_id: "111", fase: 0, progresso: 20, chunk_order: 1, erro_codigo: null },
        p_metadata: { source: "meta_webhook" },
      },
    });
    expect((rpcs[0]!.args.p_payload as { value: { history: unknown[] } }).value.history).toHaveLength(1);
  });

  it("falha ao enfileirar responde 503 (a Meta reentrega; o resto é idempotente) e diz no corpo", async () => {
    erroRpc = { message: "banco fora" };
    const res = await POST(entrega(F[1]), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ outcomes: ["history:falhou_enfileirar"] });
  });
});
