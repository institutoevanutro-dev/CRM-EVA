import { describe, expect, it } from "vitest";

import type { Message } from "@/lib/types/messaging";
import { posicoesNoTurno } from "./turnos";

const T0 = Date.parse("2026-11-08T12:00:00.000Z");
function m(id: string, minutos: number, over: Partial<Message> = {}): Message {
  return {
    id,
    direction: "outbound",
    sent_via: "ai",
    sent_by_user_id: null,
    metadata: {},
    sent_at: new Date(T0 + minutos * 60_000).toISOString(),
    ...over,
  } as Message;
}
const pos = (itens: Array<Message | null>) =>
  [...posicoesNoTurno(itens).values()].map((p) => `${p.inicio ? "I" : "-"}${p.fim ? "F" : "-"}`);

describe("turnos da conversa (I8)", () => {
  it("três mensagens seguidas do automático são um turno: rótulo na 1ª, ponta na última", () => {
    expect(pos([m("a", 0), m("b", 1), m("c", 2)])).toEqual(["I-", "--", "-F"]);
  });

  it("mais de 5 min entre duas mensagens abre turno novo; 5 min exatos não", () => {
    expect(pos([m("a", 0), m("b", 5), m("c", 10.5)])).toEqual(["I-", "-F", "IF"]);
  });

  it("muda a direção, a origem ou o autor: turno novo", () => {
    expect(pos([m("a", 0), m("b", 1, { direction: "inbound", sent_via: "external_device" })])).toEqual(["IF", "IF"]);
    expect(pos([m("a", 0), m("b", 1, { sent_via: "user", sent_by_user_id: "u1" })])).toEqual(["IF", "IF"]);
    expect(
      pos([m("a", 0, { sent_via: "user", sent_by_user_id: "u1" }), m("b", 1, { sent_via: "user", sent_by_user_id: "u2" })]),
    ).toEqual(["IF", "IF"]);
    expect(pos([m("a", 0, { metadata: { ai_actor_name: "Agente A" } }), m("b", 1)])).toEqual(["IF", "IF"]);
  });

  it("a resposta pronta é voz própria, mesmo saindo como 'ai'", () => {
    expect(pos([m("a", 0), m("b", 1, { metadata: { resposta_pronta_id: "x" } })])).toEqual(["IF", "IF"]);
  });

  it("uma nota interna no meio quebra o turno", () => {
    expect(pos([m("a", 0), null, m("b", 1)])).toEqual(["IF", "IF"]);
  });
});
