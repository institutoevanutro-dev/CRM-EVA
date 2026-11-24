/**
 * A RESPOSTA DO RESPONSÁVEL PELA TELA CALA A IA ATÉ A DEVOLUÇÃO.
 *
 * Porte do upstream melgarafael/DeskcommCRM#5176 (contribuição de @fcostamil-hub),
 * em `app/api/v1/messages/_handler.ts`:
 *   1. o responsável (`assigned_to_user_id`) responde: silêncio `'infinity'`;
 *   2. já em `'infinity'`: nada a regravar;
 *   3. quem NÃO é o responsável responde: a janela da pausa de sempre (5 min);
 *   4. conversa sem responsável: a janela da pausa de sempre;
 *   5. isolamento entre organizações: a conversa de outra org não é achada (404).
 *
 * O que o upstream também prova neste arquivo e não entra aqui:
 *   - o modo "IA com o dono" (#3967), que não existe neste fork;
 *   - a guarda antes de cada envio do turno (`iaVetadaNoEnvio`): neste fork quem
 *     confere é o sink, bolha a bolha (`pessoaAssumiuAConversa`,
 *     `lib/agent-engine/edge/crm/send-message.ts`), com prova própria em
 *     `tests/invariants/ia-nao-fala-por-cima-de-quem-assumiu.test.ts`.
 *
 * SABOTAGEM (medida): trocar `c.assigned_to_user_id === ctx.actor.id` por `false`
 * no handler faz o caso 1 reprovar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const RESPONSAVEL = "66666666-6666-4666-8666-666666666666";
const COLEGA = "77777777-7777-4777-8777-777777777777";

function duble(opts: { botSilencedUntil?: string | null; assignedToUserId?: string | null }) {
  const { supabase, capturas } = criarDubleDoHandler({
    conversation: {
      id: CONV_ID,
      organization_id: ORG_A,
      contact_id: CONTACT_ID,
      channel_session_id: SESSION_ID,
      is_group: false,
      group_chat_id: null,
      bot_silenced_until: opts.botSilencedUntil ?? null,
      assigned_to_user_id: opts.assignedToUserId ?? null,
      assignee_kind: opts.assignedToUserId ? "user" : null,
      contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
      channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING" },
    },
    rpcData: {
      organization_id: ORG_A,
      contact_id: CONTACT_ID,
      conversation_id: CONV_ID,
      service_revision: 1,
      demanda_id: null,
      demanda_revision: null,
      status: "open",
      demanda_fechada_em: null,
    },
  });
  return { supabase, patches: capturas.patches.conversations! };
}

const inputMsg = { conversation_id: CONV_ID, type: "text", body: "Olá, suporte técnico." } as SendMessageInput;
const ctxDe = (userId: string, organizationId = ORG_A): HandlerCtx => ({
  organization_id: organizationId,
  actor: { type: "user", id: userId },
  requestId: `req-${userId.slice(0, 4)}`,
});

function wahaConfigured() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: { id: "MSG_OK" } }), { status: 200 })));
}

function esperaJanelaDeCincoMinutos(silencio: unknown, antes: number, depois: number) {
  expect(silencio).not.toBe("infinity");
  const ate = new Date(silencio as string).getTime();
  expect(ate).toBeGreaterThanOrEqual(antes + 5 * 60 * 1000 - 1000);
  expect(ate).toBeLessThanOrEqual(depois + 5 * 60 * 1000 + 1000);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a resposta pela tela e o silêncio da IA (porte do upstream #5176)", () => {
  it("1. o responsável responde: a IA fica calada até a devolução ('infinity')", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({ assignedToUserId: RESPONSAVEL });

    await sendMessageHandler(supabase, ctxDe(RESPONSAVEL), inputMsg);

    expect(patches[patches.length - 1]!.bot_silenced_until).toBe("infinity");
  });

  it("2. o responsável responde com a IA já calada para sempre: nada a regravar", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({ assignedToUserId: RESPONSAVEL, botSilencedUntil: "infinity" });

    await sendMessageHandler(supabase, ctxDe(RESPONSAVEL), inputMsg);

    expect(patches[patches.length - 1]).not.toHaveProperty("bot_silenced_until");
  });

  it("3. um colega que NÃO é o responsável responde: só a janela da pausa, nunca 'infinity'", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({ assignedToUserId: RESPONSAVEL });

    const antes = Date.now();
    await sendMessageHandler(supabase, ctxDe(COLEGA), inputMsg);
    esperaJanelaDeCincoMinutos(patches[patches.length - 1]!.bot_silenced_until, antes, Date.now());
  });

  it("4. conversa sem responsável: a resposta pontual pausa só pela janela de sempre", async () => {
    wahaConfigured();
    const { supabase, patches } = duble({ assignedToUserId: null });

    const antes = Date.now();
    await sendMessageHandler(supabase, ctxDe(RESPONSAVEL), inputMsg);
    esperaJanelaDeCincoMinutos(patches[patches.length - 1]!.bot_silenced_until, antes, Date.now());
  });

  it("5. isolamento entre organizações: a conversa de outra org não é achada (404)", async () => {
    wahaConfigured();
    // O filtro `.eq("organization_id", ctx.organization_id)` não acha a conversa
    // de outro tenant (data: null).
    const supabaseMock = {
      from: (table: string) => ({
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => {
              if (table === "organizations") return { data: { status: "active" }, error: null };
              return { data: null, error: null };
            },
          };
          return chain;
        },
      }),
    } as unknown as Parameters<typeof sendMessageHandler>[0];

    await expect(sendMessageHandler(supabaseMock, ctxDe(RESPONSAVEL, ORG_B), inputMsg)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });
});
