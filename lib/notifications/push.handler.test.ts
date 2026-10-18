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
  aQuemVe: vi.fn(async (_org: string, _conversa: string, _payload: unknown) => ({ sent: 1, gone: 0 })),
}));
vi.mock("./web_push", () => ({
  enviarPushDaOrg: envio.daOrg,
  enviarPushAoUsuario: vi.fn(async () => ({ sent: 0, gone: 0 })),
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
});
