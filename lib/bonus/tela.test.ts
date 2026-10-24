import { describe, expect, it } from "vitest";

import { diaNoPeriodo, periodoAberto } from "./tela";

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
