/**
 * A borda que este teste prende é a das 21h de domingo em São Paulo — e ela
 * vira uma linha porque o instante é parâmetro.
 */
import { describe, expect, it } from "vitest";

import { ancoraLocalDoDia, diaDeHojeNoFuso, semanaSemente } from "./semana-semente";
import { diaLocalISO } from "./fuso";

const SP = "America/Sao_Paulo";

describe("a semana que a agenda abre", () => {
  it("no domingo à noite em São Paulo, é a semana do DOMINGO — mesmo com UTC já em segunda", () => {
    // 2026-09-21T00:30Z: UTC já é SEGUNDA, São Paulo ainda é domingo, 21:30.
    const { de } = semanaSemente(new Date("2026-09-21T00:30:00Z"), SP);
    expect(diaLocalISO(de, SP)).toBe("2026-09-14");
  });

  it("no fuso do SERVIDOR (UTC), o mesmo instante cai na semana seguinte — a divergência existe", () => {
    const { de } = semanaSemente(new Date("2026-09-21T00:30:00Z"), "UTC");
    expect(diaLocalISO(de, "UTC")).toBe("2026-09-21");
  });

  it("depois da meia-noite de São Paulo, as duas réguas voltam a concordar", () => {
    const instante = new Date("2026-09-21T03:30:00Z"); // 00:30 de segunda em SP
    expect(diaLocalISO(semanaSemente(instante, SP).de, SP)).toBe("2026-09-21");
    expect(diaLocalISO(semanaSemente(instante, "UTC").de, "UTC")).toBe("2026-09-21");
  });

  it("começa na segunda e termina na segunda seguinte, exclusivo", () => {
    const { de, ate } = semanaSemente(new Date("2026-09-16T15:00:00Z"), SP);
    expect(diaLocalISO(de, SP)).toBe("2026-09-14");
    expect(diaLocalISO(ate, SP)).toBe("2026-09-21");
    expect(de.getTime()).toBeLessThan(ate.getTime());
  });

  it("a semana começa à MEIA-NOITE local, não à meia-noite de UTC", () => {
    const { de } = semanaSemente(new Date("2026-09-16T15:00:00Z"), SP);
    expect(de.toISOString()).toBe("2026-09-14T03:00:00.000Z"); // 00:00 em SP (GMT-3)
  });

  it("atravessa a virada do horário de verão sem perder nem inventar hora", () => {
    // Sydney adianta o relógio às 2h de domingo 2026-10-04, o último dia da
    // semana que começa na segunda 28/09: ela tem 167 horas.
    const fuso = "Australia/Sydney";
    const { de, ate } = semanaSemente(new Date("2026-10-01T12:00:00Z"), fuso);
    expect(diaLocalISO(de, fuso)).toBe("2026-09-28");
    expect(diaLocalISO(ate, fuso)).toBe("2026-10-05");
    expect((ate.getTime() - de.getTime()) / 3_600_000).toBe(167);
  });
});

describe("o dia de hoje no fuso da organização", () => {
  it("atravessa a fronteira como DATA, e a âncora local cai no mesmo dia", () => {
    // 2026-09-20T00:30Z: em São Paulo ainda é sábado 19.
    const instante = new Date("2026-09-20T00:30:00Z");
    expect(diaDeHojeNoFuso(instante, SP)).toBe("2026-09-19");
    expect(diaDeHojeNoFuso(instante, "UTC")).toBe("2026-09-20");

    const ancora = ancoraLocalDoDia("2026-09-19");
    expect(ancora.getFullYear()).toBe(2026);
    expect(ancora.getMonth()).toBe(8); // setembro
    expect(ancora.getDate()).toBe(19);
  });

  it("a âncora é ao MEIO-DIA — meia-noite ficaria a um passo de virar o dia", () => {
    // Com 00:00, uma diferença de uma hora (horário de verão, relógio do
    // sistema) muda a DATA. Ao meio-dia, não há borda a doze horas.
    expect(ancoraLocalDoDia("2026-09-19").getHours()).toBe(12);
  });
});
