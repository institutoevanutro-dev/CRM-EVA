/**
 * Os avisos que pedem gente vão ao CELULAR, no idioma da organização.
 *
 * O som da Central só toca com o CRM aberto. O mesmo momento que tem som
 * (passagem para pessoa) vira push; o resto da Central não. E o push não carrega
 * dado do cliente: ele aparece na tela bloqueada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true, vapidPublica: () => "pub", vapidSubject: async () => "mailto:x@y" }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAoUsuario: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";

const filtros: Array<[string, string, unknown]> = [];

function banco(linhas: Record<string, Record<string, unknown> | null>) {
  return {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([tabela, coluna, valor]);
          return q;
        },
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      };
      return q;
    },
  };
}

const evento = (event_type: string, payload: Record<string, unknown>): EventRow => ({
  id: "evt", organization_id: ORG, event_type, entity_kind: "agent_inbox_item", entity_id: null,
  payload, metadata: {}, consumed_by: [], attempts: 0, created_at: new Date().toISOString(),
});

beforeEach(() => {
  vi.mocked(enviarPushDaOrg).mockClear();
  filtros.length = 0;
});

describe("aviso da Central → celular", () => {
  it("escuta o anúncio do aviso (migration 0314)", () => {
    expect(webPushInboundHandler.events).toContain("central.aviso_criado");
  });

  it("passagem para pessoa: em espanhol, abrindo a conversa", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({
      agent_inbox_items: { id: "i2", kind: "handoff", ref_kind: "conversation", ref_id: "c1", title: "Handoff humano solicitado — assumir a conversa", body: null },
      organizations: { locale: "es" },
    }) as never);
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i2" }));
    expect(vi.mocked(enviarPushDaOrg).mock.calls[0]![1]).toEqual({
      title: "La IA pasó una conversación al equipo",
      body: "Abre la conversación para responder al cliente.",
      tag: "aviso:i2",
      href: "/app/inbox/c1",
    });
    // O aviso é lido com o filtro da organização do evento.
    expect(filtros).toContainEqual(["agent_inbox_items", "organization_id", ORG]);
  });

  it("passagem de clone antigo (ref no contato) abre o contato", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({
      agent_inbox_items: { id: "i3", kind: "handoff", ref_kind: "contact", ref_id: "k1", title: "Handoff", body: null },
      organizations: { locale: "pt-BR" },
    }) as never);
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i3" }));
    expect(vi.mocked(enviarPushDaOrg).mock.calls[0]![1]).toMatchObject({
      title: "A IA passou uma conversa para a equipe",
      href: "/app/contacts/k1",
    });
  });

  it("IA sem saldo e `other` + negócio: avisos que este fork não faz tocar ficam só na tela", async () => {
    for (const item of [
      { id: "i4", kind: "other", ref_kind: "ai_provider_credential", ref_id: "cred-1", title: "Sem saldo", body: "…" },
      { id: "i6", kind: "other", ref_kind: "lead", ref_id: "l1", title: "Negócio entrou em «Pedido confirmado»", body: "…" },
    ]) {
      vi.mocked(createAdminClient).mockReturnValue(banco({ agent_inbox_items: item, organizations: { locale: "pt-BR" } }) as never);
      const r = await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: item.id }));
      expect(r.status, item.ref_kind).toBe("skipped");
    }
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("aviso que não pede gente fica só na tela", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({
      agent_inbox_items: { id: "i5", kind: "channel_template_review", ref_kind: null, ref_id: null, title: "Modelo aprovado", body: null },
      organizations: { locale: "es" },
    }) as never);
    const r = await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i5" }));
    expect(r.status).toBe("skipped");
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("aviso que sumiu antes do dreno não manda nada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ agent_inbox_items: null }) as never);
    const r = await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "ausente" }));
    expect(r.status).toBe("skipped");
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });
});
