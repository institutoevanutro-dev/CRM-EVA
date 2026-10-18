import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `enviarPushAQuemVeAConversa` — push de `message.received`. Só sai para as
 * inscrições que o banco devolveu como capazes de ver a conversa
 * (`fn_push_inscricoes_que_veem_a_conversa`, migration 0378), e a faxina
 * 404/410 continua valendo.
 *
 * Portado do projeto original (DeskcommCRM, PR #2590 de @melgarafael).
 */
const sendNotification = vi.hoisted(() => vi.fn());
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }));
vi.mock("./vapid", () => ({ vapidPronto: () => true, vapidPublica: () => "pub", vapidSubject: () => "mailto:x@y" }));
vi.mock("@/lib/env", () => ({ env: { VAPID_PRIVATE_KEY: "priv" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { enviarPushAQuemVeAConversa } from "./web_push";

type Linha = { id: string; user_id: string; endpoint: string };

function adminFalso(linhas: Linha[], erro: { message: string } | null = null) {
  const chamadas: Array<[string, unknown]> = [];
  const apagadas: Array<[string, string]> = [];
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      chamadas.push([fn, args]);
      return erro
        ? { data: null, error: erro }
        : { data: linhas.map((l) => ({ ...l, p256dh: "k", auth: "a" })), error: null };
    },
    from: () => ({
      delete: () => ({
        eq: async (c: string, v: string) => {
          apagadas.push([c, v]);
          return { error: null };
        },
      }),
    }),
  };
  return { admin, chamadas, apagadas };
}

const payload = { title: "t", body: "b" } as never;

describe("enviarPushAQuemVeAConversa", () => {
  beforeEach(() => {
    sendNotification.mockReset();
  });

  it("pergunta ao banco quem vê a conversa DO EVENTO e envia só a essas inscrições", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin, chamadas } = adminFalso([{ id: "s1", user_id: "u-a", endpoint: "https://push/a" }]);
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, admin as never);
    expect(chamadas).toEqual([
      ["fn_push_inscricoes_que_veem_a_conversa", { p_org: "org-1", p_conversation: "conv-1" }],
    ]);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(sendNotification.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint)).toEqual([
      "https://push/a",
    ]);
  });

  it("inscrição morta (410) é apagada; a viva recebe", async () => {
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/morta")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    const { admin, apagadas } = adminFalso([
      { id: "morta", user_id: "u-a", endpoint: "https://push/morta" },
      { id: "viva", user_id: "u-a", endpoint: "https://push/viva" },
    ]);
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, admin as never);
    expect(r).toEqual({ sent: 1, gone: 1 });
    expect(apagadas).toEqual([["id", "morta"]]);
  });

  it("falha ao perguntar quem vê → ninguém recebe", async () => {
    const { admin } = adminFalso([], { message: "banco fora" });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
