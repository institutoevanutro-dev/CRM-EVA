/**
 * `lead_created` é o único rótulo da timeline que depende de DADO da linha
 * (o canal por onde o contato entrou), não só do tipo — ver o cabeçalho de
 * `activityLabel` em `activity-vocabulary.ts`. Este teste prova as duas
 * variações e o comportamento de linha antiga (sem `payload.canal`).
 */
import { describe, expect, it } from "vitest";

import { activityLabel, rotuloDoCanal } from "./activity-vocabulary";

describe("activityLabel(\"lead_created\", payload)", () => {
  it("canal instagram → \"Entrou pelo Instagram\"", () => {
    expect(activityLabel("lead_created", { canal: "instagram" })).toBe("Entrou pelo Instagram");
  });

  it("canal whatsapp → \"Entrou pelo WhatsApp\"", () => {
    expect(activityLabel("lead_created", { canal: "whatsapp" })).toBe("Entrou pelo WhatsApp");
  });

  it("sem payload (linha antiga, anterior a payload.canal) → cai no WhatsApp, o texto de sempre", () => {
    expect(activityLabel("lead_created")).toBe("Entrou pelo WhatsApp");
    expect(activityLabel("lead_created", null)).toBe("Entrou pelo WhatsApp");
    expect(activityLabel("lead_created", {})).toBe("Entrou pelo WhatsApp");
  });

  it("canal desconhecido no payload também cai no WhatsApp", () => {
    expect(activityLabel("lead_created", { canal: "sms" })).toBe("Entrou pelo WhatsApp");
  });

  it("um tipo sem canal (ex.: stage_changed) ignora o payload e usa o vocabulário fixo", () => {
    expect(activityLabel("stage_changed", { canal: "instagram" })).toBe("Mudou de estágio");
  });
});

describe("rotuloDoCanal", () => {
  it("instagram → \"Instagram\", whatsapp → \"WhatsApp\"", () => {
    expect(rotuloDoCanal("instagram")).toBe("Instagram");
    expect(rotuloDoCanal("whatsapp")).toBe("WhatsApp");
  });

  it("ausente/desconhecido cai em WhatsApp", () => {
    expect(rotuloDoCanal(null)).toBe("WhatsApp");
    expect(rotuloDoCanal(undefined)).toBe("WhatsApp");
    expect(rotuloDoCanal("sms")).toBe("WhatsApp");
  });
});
