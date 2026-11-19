import { describe, expect, it } from "vitest";

import { diaNoPeriodo, mesesParaEscolher, nomeDoMes, periodoAberto, somarMeses } from "./tela";

describe("período aberto do lançamento manual de stories", () => {
  it("vai do dia 1 do mês de hoje até hoje", () => {
    expect(periodoAberto("2026-10-24")).toEqual({ min: "2026-10-01", max: "2026-10-24" });
  });

  it("aceita os dias do mês até hoje, inclusive as pontas", () => {
    expect(diaNoPeriodo("2026-10-01", "2026-10-24")).toBe(true);
    expect(diaNoPeriodo("2026-10-24", "2026-10-24")).toBe(true);
  });

  it("recusa dia futuro, mês fechado, dia impossível e texto torto", () => {
    expect(diaNoPeriodo("2026-10-25", "2026-10-24")).toBe(false);
    expect(diaNoPeriodo("2026-09-30", "2026-10-24")).toBe(false);
    expect(diaNoPeriodo("2026-02-31", "2026-02-28")).toBe(false);
    expect(diaNoPeriodo("2026-10-00", "2026-10-24")).toBe(false);
    expect(diaNoPeriodo("2026-10-1", "2026-10-24")).toBe(false);
    expect(diaNoPeriodo("", "2026-10-24")).toBe(false);
  });
});

describe("meses do placar e das metas", () => {
  it("soma e volta meses virando o ano", () => {
    expect(somarMeses("2026-12", 1)).toBe("2027-01");
    expect(somarMeses("2026-01", -1)).toBe("2025-12");
    expect(somarMeses("2026-11", -13)).toBe("2025-10");
  });

  it("nomeia o mês no idioma de quem lê", () => {
    expect(nomeDoMes("2026-11", "pt-BR")).toBe("Novembro de 2026");
    expect(nomeDoMes("2026-11", "es")).toBe("Noviembre de 2026");
  });

  it("oferece o mês atual e os 11 seguintes, mais os já gravados", () => {
    const meses = mesesParaEscolher("2026-11", ["2026-05"]);
    expect(meses[0]).toBe("2026-05");
    expect(meses[1]).toBe("2026-11");
    expect(meses.at(-1)).toBe("2027-10");
    expect(meses).toHaveLength(13);
  });
});
