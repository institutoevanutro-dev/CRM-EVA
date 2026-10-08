import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectUnscheduledFollowUpPromise } from "@/lib/agent-engine/guardrails/human-promise";

describe("pedir espera sem nada que volte é promessa sem retorno", () => {
  it.each([
    "Estou vendo os horários da Dra. Ana. Me dá só um instante?",
    "Me dá um minutinho que já confiro.",
    "Me da um momento, por favor.",
  ])("detecta: %s", (body) => {
    expect(detectUnscheduledFollowUpPromise(body)).toBe(true);
  });

  it.each([
    "Fica à vontade, me dá um retorno quando puder.",
    "Me dá seu nome completo, por favor?",
    "A sessão dura um momento só, uns 40 minutos.",
  ])("não detecta: %s", (body) => {
    expect(detectUnscheduledFollowUpPromise(body)).toBe(false);
  });
});

describe("a passagem decidida pelo modelo não fala como se o cliente tivesse pedido", () => {
  it("o piso de request_human_handoff usa o motivo `outro`, não `pediu_humano`", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const bloco = fonte.slice(fonte.indexOf("request_human_handoff: tool({"));
    const piso = bloco.slice(0, bloco.indexOf("applyRequestHumanHandoff("));
    expect(piso).toContain("motivo: 'outro'");
    expect(piso).not.toContain("motivo: 'pediu_humano'");
  });
});
