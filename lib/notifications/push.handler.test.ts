import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ vapidPronto: false }));

vi.mock("@/lib/notifications/vapid", () => ({
  vapidPronto: () => estado.vapidPronto,
}));
vi.mock("./vapid", () => ({
  vapidPronto: () => estado.vapidPronto,
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    }),
  }),
}));

const envio = vi.hoisted(() => ({
  daOrg: vi.fn(async () => ({ sent: 9, gone: 0 })),
  aoUsuario: vi.fn(async () => ({ sent: 0, gone: 0 })),
  aQuemVe: vi.fn(async (_org: string, _conversa: string, _payload: unknown, _admin?: unknown, _so?: readonly string[]) => ({ sent: 1, gone: 0 })),
}));
vi.mock("./web_push", () => ({
  enviarPushDaOrg: envio.daOrg,
  enviarPushAoUsuario: envio.aoUsuario,
  enviarPushAQuemVeAConversa: envio.aQuemVe,
}));

import { webPushInboundHandler } from "./push.handler";

function inbound(payload: Record<string, unknown>) {
  return {
    id: "e1",
    organization_id: "org",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "m1",
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

describe("webPushInboundHandler", () => {
  beforeEach(() => {
    estado.vapidPronto = false;
    envio.daOrg.mockClear();
    envio.aQuemVe.mockClear();
  });

  it("pula quando VAPID não está configurado", async () => {
    const result = await webPushInboundHandler.handle(
      inbound({ conversation_id: "c1", body_preview: "oi", type: "text" }),
    );
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("vapid_ausente");
  });

  // Portado do projeto original (DeskcommCRM, PR #2590 de @melgarafael).
  it("mensagem recebida vai só a quem vê a conversa, nunca à organização inteira", async () => {
    estado.vapidPronto = true;
    const result = await webPushInboundHandler.handle(
      inbound({ conversation_id: "conv-1", body_preview: "oi", type: "text" }),
    );
    expect(result).toMatchObject({ status: "ok", detail: "sent:1" });
    expect(envio.daOrg).not.toHaveBeenCalled();
    expect(envio.aQuemVe).toHaveBeenCalledTimes(1);
    const [org, conversa] = envio.aQuemVe.mock.calls[0]!;
    expect(org).toBe("org");
    expect(conversa).toBe("conv-1");
  });

  it("sem conversation_id não envia a ninguém", async () => {
    estado.vapidPronto = true;
    const result = await webPushInboundHandler.handle(inbound({ body_preview: "oi", type: "text" }));
    expect(result).toMatchObject({ status: "skipped", detail: "sem_conversa" });
    expect(envio.daOrg).not.toHaveBeenCalled();
    expect(envio.aQuemVe).not.toHaveBeenCalled();
  });

  // Portado do DeskcommCRM (PR #2592): a menção segue a régua da 0378. O mock
  // responde pela função do banco: só QUEM_VE tem inscrição que vê a conversa.
  describe("menção (user.mentioned) — só se o mencionado pode ver a conversa", () => {
    const QUEM_VE = "user-que-ve";
    beforeEach(() => {
      estado.vapidPronto = true;
      envio.aoUsuario.mockClear();
      envio.aQuemVe.mockImplementation(async (_o, _c, _p, _a, so) => ({
        sent: (so ?? []).filter((u) => u === QUEM_VE).length,
        gone: 0,
      }));
    });

    const mencao = (payload: Record<string, unknown>) => ({
      ...inbound({ conversation_id: "conv-1", from_user_id: "autor", body_preview: "dados do cliente", ...payload }),
      event_type: "user.mentioned",
      entity_kind: "conversation_note",
    });

    it("mencionado que NÃO vê a conversa: nenhum aviso", async () => {
      const result = await webPushInboundHandler.handle(mencao({ to_user_id: "user-que-nao-ve" }));
      expect(result.detail).toBe("sent:0");
      expect(envio.aoUsuario).not.toHaveBeenCalled();
      expect(envio.daOrg).not.toHaveBeenCalled();
      const [org, conv, , , so] = envio.aQuemVe.mock.calls[0]!;
      expect([org, conv, so]).toEqual(["org", "conv-1", ["user-que-nao-ve"]]);
    });

    it("mencionado que vê a conversa: recebe o aviso com a prévia", async () => {
      const result = await webPushInboundHandler.handle(mencao({ to_user_id: QUEM_VE }));
      expect(result.detail).toBe("sent:1");
      expect((envio.aQuemVe.mock.calls[0]![2] as { body: string }).body).toBe("dados do cliente");
    });

    it("sem conversa não há como conferir: ninguém recebe", async () => {
      const result = await webPushInboundHandler.handle(mencao({ to_user_id: QUEM_VE, conversation_id: undefined }));
      expect(result.status).toBe("skipped");
      expect(envio.aoUsuario).not.toHaveBeenCalled();
      expect(envio.aQuemVe).not.toHaveBeenCalled();
    });
  });
});
