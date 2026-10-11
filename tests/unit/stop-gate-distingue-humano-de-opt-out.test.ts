import { describe, expect, it } from "vitest";

import { BEFORE_SEND_GATES, type GateContext } from "@/lib/agent-engine/guardrails/before-send";

// A tela do Inbox traduz o código do veto. Enquanto transferência e opt-out saíam
// com o mesmo código, a conversa com a equipe aparecia como "o contato pediu para
// não receber mensagens" (medido em produção, 2026-10-10).
describe("gate stop: conversa com humano não é opt-out", () => {
  const stop = BEFORE_SEND_GATES[0]!;
  const veto = (ctx: Partial<GateContext>) => stop.evaluate(ctx as GateContext);

  it("é o primeiro da cadeia", () => expect(stop.name).toBe("stop"));

  it("force_human sem bloqueio veta com código próprio", () => {
    expect(veto({ optedOut: true, comHumano: true })).toMatchObject({ pass: false, code: "conversa_com_humano" });
  });

  it("bloqueio continua contato_bloqueado", () => {
    expect(veto({ optedOut: true, comHumano: false })).toMatchObject({ pass: false, code: "contato_bloqueado" });
    expect(veto({ optedOut: true })).toMatchObject({ pass: false, code: "contato_bloqueado" });
  });

  it("sem trava, passa", () => expect(veto({ optedOut: false })).toEqual({ pass: true }));
});
