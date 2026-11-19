import { describe, expect, it } from "vitest";

import { conversaNoAutomatico, shouldNotifyInbound } from "./policy";

describe("shouldNotifyInbound", () => {
  const base = {
    direction: "inbound" as const,
    conversationId: "c1",
    openConversationId: "c2",
    tabFocused: true,
  };

  it("emite inbound de outra conversa com a aba em foco", () => {
    expect(shouldNotifyInbound(base)).toBe(true);
  });

  it("pula inbound da conversa já aberta na aba em foco", () => {
    expect(shouldNotifyInbound({ ...base, openConversationId: "c1" })).toBe(false);
  });

  it("emite inbound da conversa aberta se a aba NÃO está em foco", () => {
    expect(shouldNotifyInbound({ ...base, openConversationId: "c1", tabFocused: false })).toBe(
      true,
    );
  });

  it("pula outbound", () => {
    expect(shouldNotifyInbound({ ...base, direction: "outbound" })).toBe(false);
  });

  it("pula payload sintético de reassinatura", () => {
    expect(shouldNotifyInbound({ ...base, tipo: "reassinado" })).toBe(false);
  });

  it("pula sem conversationId", () => {
    expect(shouldNotifyInbound({ ...base, conversationId: null })).toBe(false);
  });
});

describe("conversaNoAutomatico", () => {
  const semDono = { status: "open", assigned_to_user_id: null, bot_silenced_until: null, contacts: { force_human: false } };

  it("conversa sem dono e sem trava, numa org com automático: cala", () => {
    expect(conversaNoAutomatico(semDono, true)).toBe(true);
  });

  it("com dono, pausada ou com o contato travado: avisa", () => {
    expect(conversaNoAutomatico({ ...semDono, assigned_to_user_id: "u-1" }, true)).toBe(false);
    expect(conversaNoAutomatico({ ...semDono, bot_silenced_until: "infinity" }, true)).toBe(false);
    expect(conversaNoAutomatico({ ...semDono, contacts: { force_human: true } }, true)).toBe(false);
  });

  it("sem certeza não cala: org sem automático, desconhecida ou conversa não lida", () => {
    expect(conversaNoAutomatico(semDono, false)).toBe(false);
    expect(conversaNoAutomatico(semDono, undefined)).toBe(false);
    expect(conversaNoAutomatico(null, true)).toBe(false);
    expect(conversaNoAutomatico({ contacts: null }, true)).toBe(false);
  });
});
