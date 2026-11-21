import { describe, expect, it } from "vitest";

import { faixaDaJornada, profissionaisComProcedimento } from "./marcacao-simples";

describe("profissionaisComProcedimento (21/11/2026)", () => {
  const pessoas = [{ id: "ana" }, { id: "beto" }, { id: "carla" }];
  it("só quem tem procedimento próprio, ou procedimento sem dono (de todos)", () => {
    expect(profissionaisComProcedimento(pessoas, [{ id: "t1", donoId: "ana" }]).map((p) => p.id)).toEqual(["ana"]);
    expect(profissionaisComProcedimento(pessoas, [{ id: "t1", donoId: null }]).map((p) => p.id)).toEqual([
      "ana",
      "beto",
      "carla",
    ]);
    expect(profissionaisComProcedimento(pessoas, [])).toEqual([]);
  });
});

describe("faixaDaJornada", () => {
  it("do começo mais cedo ao fim mais tarde, de qualquer dia", () => {
    expect(
      faixaDaJornada([
        { start: "09:00", end: "12:00" },
        { start: "08:30", end: "11:00" },
        { start: "14:00", end: "19:30" },
      ]),
    ).toEqual({ de: 8 * 60 + 30, ate: 19 * 60 + 30 });
  });
  it("sem janela, não sabe", () => {
    expect(faixaDaJornada([])).toBeNull();
  });
});
