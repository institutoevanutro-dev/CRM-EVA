import { describe, expect, it } from "vitest";

import { diasDoMes, diasUteisDoMes, ehDiaUtil, inicioDoDia, janelaDoMes, mesDe, somarDias } from "./calendario";

const SP = "America/Sao_Paulo";

describe("calendário do bônus", () => {
  it("novembro de 2026 tem 30 dias e 21 dias úteis", () => {
    expect(diasDoMes("2026-11")).toHaveLength(30);
    expect(diasUteisDoMes("2026-11", [])).toHaveLength(21);
  });

  it("feriado sai da conta de todo mundo", () => {
    expect(diasUteisDoMes("2026-11", ["2026-11-02", "2026-11-20"])).toHaveLength(19);
    expect(ehDiaUtil("2026-11-02", ["2026-11-02"])).toBe(false);
  });

  it("sábado e domingo não são dia útil", () => {
    expect(ehDiaUtil("2026-11-07", [])).toBe(false);
    expect(ehDiaUtil("2026-11-08", [])).toBe(false);
    expect(ehDiaUtil("2026-11-09", [])).toBe(true);
  });

  it("somarDias atravessa mês e ano", () => {
    expect(somarDias("2026-11-30", 1)).toBe("2026-12-01");
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somarDias("2026-11-03", -60)).toBe("2026-09-04");
  });

  it("o mês começa à meia-noite LOCAL, não UTC", () => {
    const { inicio, fim } = janelaDoMes("2026-11", SP);
    expect(inicio.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(fim.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(inicioDoDia("2026-11-03", SP).toISOString()).toBe("2026-11-03T03:00:00.000Z");
  });

  it("mesDe corta o dia", () => {
    expect(mesDe("2026-11-03")).toBe("2026-11");
  });
});
