import { describe, expect, it } from "vitest";

import { nomeCurto, rotuloDoBloco } from "@/components/agenda/rotulo-do-bloco";

/** A1 do pacote 2a de design: o bloco da grade diz quem vem. Nomes fictícios. */
describe("rótulo do bloco da agenda", () => {
  it("encurta para primeiro nome e inicial do último", () => {
    expect(nomeCurto("Marina Alves Prado")).toBe("Marina P.");
    expect(nomeCurto("  Pedro  ")).toBe("Pedro");
    expect(nomeCurto("")).toBe("");
  });

  it("a partir de 45 min: paciente em cima, hora e procedimento embaixo", () => {
    const base = { titulo: "Consulta", paciente: "Marina Alves", hora: "09:30", duracaoMin: 45 };
    expect(rotuloDoBloco({ ...base, visao: "semana" })).toEqual({
      principal: "Marina A.",
      apoio: "09:30 · Consulta",
    });
    expect(rotuloDoBloco({ ...base, visao: "dia" })).toEqual({
      principal: "Marina Alves",
      apoio: "09:30 · Consulta",
    });
  });

  it("15 e 30 min: uma linha só, hora na frente do nome", () => {
    for (const duracaoMin of [15, 30]) {
      expect(
        rotuloDoBloco({ titulo: "Retorno", paciente: "Pedro Lima", hora: "09:15", duracaoMin, visao: "semana" }),
      ).toEqual({ principal: "09:15 Pedro L.", apoio: null });
    }
  });

  it("sem paciente fica o título", () => {
    expect(rotuloDoBloco({ titulo: "Reunião", hora: "14:00", duracaoMin: 60, visao: "semana" })).toEqual({
      principal: "Reunião",
      apoio: "14:00",
    });
    expect(rotuloDoBloco({ titulo: "Ocupado", hora: "14:00", duracaoMin: 30, visao: "dia" })).toEqual({
      principal: "14:00 Ocupado",
      apoio: null,
    });
  });
});
