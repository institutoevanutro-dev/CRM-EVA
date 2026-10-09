/**
 * A janela de 24h vista de QUEM INTEGRA POR TOKEN (porte de
 * melgarafael/DeskcommCRM #1677, só a recusa 422; o gatilho `message.failed`
 * e a migration 0417 do original ficaram de fora).
 *
 * No canal oficial, texto livre com a janela fechada recebia 201, a linha
 * virava `sent` e a plataforma recusava a ENTREGA depois, pelo webhook, com
 * 131047 — quem integrava registrava "enviado" e o cliente nunca recebia.
 *
 *   1. janela fechada + texto livre + token → 422 `janela_fechada`, SEM linha;
 *   2. janela aberta → segue como antes;
 *   3. modelo aprovado continua saindo (é a saída que o 422 indica);
 *   4. canal por QR (sem janela), quem digita na tela e o Instagram (que tem
 *      a própria recusa terminal) ficam intocados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import {
  CHANNEL_PROVIDER_INSTAGRAM,
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_WAHA,
} from "@/lib/channels/capabilities";
import type * as Canais from "@/lib/channels";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";

const sendSpy = vi.fn(async (..._a: unknown[]) => ({ externalId: "wamid.OK" as string | null }));
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<typeof Canais>();
  return {
    ...real,
    getAdapter: (p: Parameters<typeof real.getAdapter>[0]) => ({
      ...real.getAdapter(p),
      isConfigured: () => true,
      send: sendSpy,
    }),
  };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const { sendMessageHandler } = await import("@/app/api/v1/messages/_handler");

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";
const HORA = 60 * 60 * 1000;

type Row = Record<string, unknown>;

function conversa(o: { provider?: string; inboundHaMs?: number | null } = {}): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: "IGSID-1",
    last_inbound_at:
      o.inboundHaMs === null ? null : new Date(Date.now() - (o.inboundHaMs ?? 2 * HORA)).toISOString(),
    contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      provider: o.provider ?? CHANNEL_PROVIDER_META,
      ig_account_id: "IGACC",
      meta_phone_number_id: "PNID",
      waha_session_name: o.provider === CHANNEL_PROVIDER_WAHA ? "default" : null,
      status: "WORKING",
      archived_at: null,
    },
  };
}

function supabaseFalso(conv: Row) {
  const inserts: Row[] = [];
  const state: { message: Row | null } = { message: null };
  const encadeavel = (fim: () => unknown) => {
    const q: Record<string, unknown> = {
      eq: () => q,
      is: () => q,
      in: () => q,
      select: () => q,
      maybeSingle: async () => fim(),
      single: async () => fim(),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
    };
    return q;
  };
  const client = {
    from(table: string) {
      if (table === "conversations")
        return { select: () => encadeavel(() => ({ data: conv, error: null })), update: () => encadeavel(() => ({ error: null })) };
      if (table === "channel_sessions") return { select: () => encadeavel(() => ({ data: { metadata: {} }, error: null })) };
      if (table === "contacts") return { update: () => encadeavel(() => ({ error: null })) };
      if (table === "messages")
        return {
          insert: (row: Row) => {
            inserts.push(row);
            state.message = { id: "msg-1", external_id: null, ack: null, error_code: null, error_message: null, ...row };
            return encadeavel(() => ({ data: { ...state.message }, error: null }));
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            return encadeavel(() => ({ data: { ...state.message }, error: null }));
          },
          delete: () => encadeavel(() => ({ error: null })),
        };
      throw new Error(`tabela inesperada '${table}'`);
    },
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { client, inserts };
}

const porToken: HandlerCtx = { organization_id: ORG, actor: deriveActor(["mcp:write"], TOKEN_ID), requestId: "req-1677" };
const humano: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-tela" };
const texto = () => ({ conversation_id: CONV, type: "text", body: "oi" }) as SendMessageInput;

afterEach(() => sendSpy.mockClear());

describe("envio por token respeita a janela de 24h do canal oficial", () => {
  it("texto livre fora da janela: 422 janela_fechada, com o detalhe, e NADA é gravado", async () => {
    const conv = conversa({ inboundHaMs: 30 * HORA });
    const { client, inserts } = supabaseFalso(conv);

    const erro = await sendMessageHandler(client, porToken, texto()).catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(422);
    expect((erro as ApiError).code).toBe("janela_fechada");
    expect((erro as ApiError).details).toMatchObject({
      codigo: "janela_fechada",
      ultima_mensagem_do_cliente: conv.last_inbound_at,
      use: "template",
      codigo_plataforma: "131047",
    });
    expect(inserts, "uma linha nasceu para um envio que já se sabia recusado").toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("cliente que NUNCA escreveu também é recusado — a janela nunca abriu", async () => {
    const { client, inserts } = supabaseFalso(conversa({ inboundHaMs: null }));
    const erro = await sendMessageHandler(client, porToken, texto()).catch((e) => e);
    expect((erro as ApiError).code).toBe("janela_fechada");
    expect((erro as ApiError).details).toMatchObject({ ultima_mensagem_do_cliente: null });
    expect(inserts).toHaveLength(0);
  });

  it("dentro da janela, o texto livre segue saindo como antes", async () => {
    const { client, inserts } = supabaseFalso(conversa({ inboundHaMs: 1 * HORA }));
    const msg = await sendMessageHandler(client, porToken, texto());
    expect(inserts).toHaveLength(1);
    expect(msg.status).toBe("sent");
  });

  it("canal por QR, sem janela: nada muda", async () => {
    const { client, inserts } = supabaseFalso(conversa({ provider: CHANNEL_PROVIDER_WAHA, inboundHaMs: null }));
    const msg = await sendMessageHandler(client, porToken, texto()).catch((e) => e);
    expect(msg).not.toBeInstanceOf(ApiError);
    expect(inserts).toHaveLength(1);
  });

  it("quem digita na tela não passa por aqui: a tela já trava o composer", async () => {
    const { client, inserts } = supabaseFalso(conversa({ inboundHaMs: 30 * HORA }));
    const msg = await sendMessageHandler(client, humano, texto()).catch((e) => e);
    expect(msg).not.toBeInstanceOf(ApiError);
    expect(inserts).toHaveLength(1);
  });

  it("Instagram mantém a recusa terminal própria (linha `failed`), sem 422", async () => {
    const { client, inserts } = supabaseFalso(
      conversa({ provider: CHANNEL_PROVIDER_INSTAGRAM, inboundHaMs: 30 * HORA }),
    );
    const msg = await sendMessageHandler(client, porToken, texto()).catch((e) => e);
    expect(msg).not.toBeInstanceOf(ApiError);
    expect(inserts).toHaveLength(1);
    expect(msg.status).toBe("failed");
  });
});
