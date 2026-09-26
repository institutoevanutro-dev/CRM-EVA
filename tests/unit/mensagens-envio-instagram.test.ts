/**
 * Instagram etapa 2: a equipe responde pelo Inbox.
 *
 * O handler endereça o cliente pelo IGSID guardado NA CONVERSA
 * (`provider_conversation_id`), aplica a janela da Meta (24h livre, 7 dias com
 * a etiqueta HUMAN_AGENT, depois fechada) no servidor e recusa remetente
 * automático num canal onde a IA não responde. Cada recusa é terminal
 * (`failed` com código), nunca `queued`.
 *
 * O adapter é o de verdade com `send` espionado: o que se afirma é o envelope
 * que sai do handler, não o fio da Graph (esse é de `canal-instagram-envio`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { CHANNEL_PROVIDER_INSTAGRAM, CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import type * as Canais from "@/lib/channels";
import type { SendMessageInput } from "@/lib/schemas";

const sendSpy = vi.fn(async (..._a: unknown[]) => ({ externalId: "mid.1" as string | null }));
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
const CONV2 = "66666666-6666-4666-8666-666666666666";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const HORA = 60 * 60 * 1000;

type Row = Record<string, unknown>;

function conversa(
  o: { id?: string; provider?: string; igsid?: string | null; inboundHaMs?: number | null; status?: string } = {},
): Row {
  return {
    id: o.id ?? CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: o.igsid === undefined ? "IGSID-1" : o.igsid,
    last_inbound_at:
      o.inboundHaMs === null ? null : new Date(Date.now() - (o.inboundHaMs ?? 2 * HORA)).toISOString(),
    contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      provider: o.provider ?? CHANNEL_PROVIDER_INSTAGRAM,
      ig_account_id: "IGACC",
      meta_phone_number_id: "PNID",
      waha_session_name: null,
      status: o.status ?? "WORKING",
      archived_at: null,
    },
  };
}

function supabaseFalso(conv: Row) {
  const state: { message: Row | null } = { message: null };
  const encadeavel = (fim: () => unknown) => {
    const q: Record<string, unknown> = {
      eq: () => q,
      is: () => q,
      select: () => q,
      maybeSingle: async () => fim(),
      single: async () => fim(),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
    };
    return q;
  };
  return {
    from(table: string) {
      if (table === "conversations")
        return { select: () => encadeavel(() => ({ data: conv, error: null })), update: () => encadeavel(() => ({ error: null })) };
      if (table === "channel_sessions") return { select: () => encadeavel(() => ({ data: { metadata: {} }, error: null })) };
      if (table === "contacts") return { update: () => encadeavel(() => ({ error: null })) };
      if (table === "messages")
        return {
          insert: (row: Row) => {
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
}

const humano: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };
const texto = (conversation_id = CONV) => ({ conversation_id, type: "text", body: "oi" }) as SendMessageInput;
const envelope = () => sendSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;

afterEach(() => sendSpy.mockClear());

describe("envio pelo Instagram", () => {
  it("dentro das 24h: sai para o IGSID da conversa, sem etiqueta", async () => {
    const msg = await sendMessageHandler(supabaseFalso(conversa()), humano, texto());
    expect(envelope()).toMatchObject({ to: "IGSID-1", sessionRef: "IGACC" });
    expect(envelope().etiquetaHumana).toBeFalsy();
    expect(msg).toMatchObject({ status: "sent", external_id: "mid.1" });
  });

  it("entre 24h e 7 dias: sai com a etiqueta humana", async () => {
    const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: 72 * HORA })), humano, texto());
    expect(envelope()).toMatchObject({ to: "IGSID-1", etiquetaHumana: true });
    expect(msg.status).toBe("sent");
  });

  it("depois de 7 dias: não chama o canal e grava fora_da_janela", async () => {
    const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: 8 * 24 * HORA })), humano, texto());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(msg).toMatchObject({
      status: "failed",
      error_code: "fora_da_janela",
      error_message:
        "A Meta só deixa responder até 7 dias depois da última mensagem dessa pessoa. Responda pelo app do Instagram se ela escrever de novo.",
    });
  });

  it("cliente que nunca escreveu: fora_da_janela, sem falar em 7 dias", async () => {
    const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: null })), humano, texto());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(msg).toMatchObject({
      status: "failed",
      error_code: "fora_da_janela",
      error_message:
        "Essa pessoa ainda não escreveu para este perfil. A Meta só deixa responder depois que ela mandar uma mensagem.",
    });
  });

  it("perfil desconectado: falha com instagram_desconectado, nunca queued (nada reenvia o Instagram)", async () => {
    const msg = await sendMessageHandler(supabaseFalso(conversa({ status: "FAILED" })), humano, texto());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(msg).toMatchObject({
      status: "failed",
      error_code: "instagram_desconectado",
      error_message: "A conexão deste perfil do Instagram caiu. Reconecte o Instagram em Conexões e envie de novo.",
    });
  });

  it("WhatsApp com sessão fora do ar segue na fila, como hoje", async () => {
    const msg = await sendMessageHandler(
      supabaseFalso(conversa({ provider: CHANNEL_PROVIDER_META, status: "FAILED" })),
      humano,
      texto(),
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(msg.status).not.toBe("failed");
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe("channel_session_not_working");
  });

  it.each([
    ["agente de IA", { type: "ai_agent", id: USER, role: "agent" }],
    ["follow-up", { type: "webhook_source", id: "enr-1" }],
  ] as const)("remetente automático (%s): recusado sem lançar", async (_n, actor) => {
    const msg = await sendMessageHandler(supabaseFalso(conversa()), { ...humano, actor }, texto());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(msg).toMatchObject({ status: "failed", error_code: "envio_automatico_indisponivel" });
  });

  describe("follow-up (origemDoEnvio: followup): só dentro das 24h", () => {
    const followup: HandlerCtx = { ...humano, actor: { type: "webhook_source", id: "enr-1" }, origemDoEnvio: "followup" };
    const agenteDoFollowup: HandlerCtx = {
      ...humano,
      actor: { type: "ai_agent", id: USER, role: "manager" },
      origemDoEnvio: "followup",
    };

    it("texto fixo a 2h da última mensagem: sai, sem etiqueta humana", async () => {
      const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: 2 * HORA })), followup, texto());
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(envelope().etiquetaHumana).toBeFalsy();
      expect(msg.status).toBe("sent");
    });

    it("texto fixo a 30h: não chama o canal e grava fora_das_24h_do_instagram", async () => {
      const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: 30 * HORA })), followup, texto());
      expect(sendSpy).not.toHaveBeenCalled();
      expect(msg).toMatchObject({
        status: "failed",
        error_code: "fora_das_24h_do_instagram",
        error_message: "Passo pulado: fora das 24h do Instagram.",
      });
    });

    it("pessoa que nunca escreveu: fora_das_24h_do_instagram", async () => {
      const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: null })), followup, texto());
      expect(sendSpy).not.toHaveBeenCalled();
      expect(msg).toMatchObject({ status: "failed", error_code: "fora_das_24h_do_instagram" });
    });

    it("passo de IA do follow-up a 2h: sai", async () => {
      const msg = await sendMessageHandler(supabaseFalso(conversa({ inboundHaMs: 2 * HORA })), agenteDoFollowup, texto());
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(msg.status).toBe("sent");
    });

    it("agente de atendimento (sem origemDoEnvio) a 2h: segue recusado", async () => {
      const msg = await sendMessageHandler(
        supabaseFalso(conversa({ inboundHaMs: 2 * HORA })),
        { ...humano, actor: { type: "ai_agent", id: USER, role: "manager" } },
        texto(),
      );
      expect(sendSpy).not.toHaveBeenCalled();
      expect(msg).toMatchObject({ status: "failed", error_code: "envio_automatico_indisponivel" });
    });

    it("WhatsApp oficial com origemDoEnvio followup fora das 24h: sem mudança", async () => {
      const msg = await sendMessageHandler(
        supabaseFalso(conversa({ provider: CHANNEL_PROVIDER_META, inboundHaMs: 30 * HORA })),
        followup,
        texto(),
      );
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(msg.status).toBe("sent");
    });
  });

  it("conversa sem IGSID: instagram_sem_destinatario, nunca queued", async () => {
    const msg = await sendMessageHandler(supabaseFalso(conversa({ igsid: null })), humano, texto());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(msg).toMatchObject({ status: "failed", error_code: "instagram_sem_destinatario" });
  });

  it("mesmo contato em dois perfis: cada envio sai para o IGSID da sua conversa", async () => {
    await sendMessageHandler(supabaseFalso(conversa({ igsid: "IGSID-A" })), humano, texto());
    expect(envelope().to).toBe("IGSID-A");
    await sendMessageHandler(supabaseFalso(conversa({ id: CONV2, igsid: "IGSID-B" })), humano, texto(CONV2));
    expect(envelope().to).toBe("IGSID-B");
  });

  it("WhatsApp oficial fora das 24h segue como hoje: o guard de 7 dias não se aplica", async () => {
    const msg = await sendMessageHandler(
      supabaseFalso(conversa({ provider: CHANNEL_PROVIDER_META, inboundHaMs: 30 * 24 * HORA })),
      humano,
      texto(),
    );
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(envelope().etiquetaHumana).toBeFalsy();
    expect(msg.status).toBe("sent");
  });
});
