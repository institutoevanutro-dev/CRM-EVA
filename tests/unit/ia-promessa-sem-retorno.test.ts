import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectUnscheduledFollowUpPromise } from "@/lib/agent-engine/guardrails/human-promise";
import { unscheduledFollowUpGate } from "@/lib/agent-engine/guardrails/before-send";

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

describe("retorno agendado sustenta a promessa do próprio assistente", () => {
  const base = (followup?: { disponivel: boolean; agendadoNesteTurno: boolean }) =>
    ({ body: "Já deixei anotado e te retorno amanhã assim que tiver a resposta.", unscheduledFollowUpEnforced: true, followup }) as never;

  it("veta sem nada agendado", () => {
    expect(unscheduledFollowUpGate.evaluate(base()).pass).toBe(false);
  });

  it("passa quando schedule_followup agendou o retorno neste turno", () => {
    expect(unscheduledFollowUpGate.evaluate(base({ disponivel: true, agendadoNesteTurno: true })).pass).toBe(true);
  });

  it("o veto ensina schedule_followup só a quem tem a tool", () => {
    const com = unscheduledFollowUpGate.evaluate(base({ disponivel: true, agendadoNesteTurno: false }));
    const sem = unscheduledFollowUpGate.evaluate(base({ disponivel: false, agendadoNesteTurno: false }));
    expect(!com.pass && com.reason).toContain("schedule_followup");
    expect(!sem.pass && sem.reason).not.toContain("schedule_followup");
  });
});
