import { describe, expect, it } from "vitest";

import { ALTURA_DE_DUAS_LINHAS, nomeCurto, rotuloDoBloco } from "@/components/agenda/rotulo-do-bloco";

/** A altura que a grade desenha para N minutos: 56 px por hora, menos 2 de respiro. */
const alturaDe = (min: number) => (min / 60) * 56 - 2;

/** A1 do pacote 2a de design: o bloco da grade diz quem vem. Nomes fictícios. */
describe("rótulo do bloco da agenda", () => {
  it("encurta para primeiro nome e inicial do último", () => {
    expect(nomeCurto("Marina Alves Prado")).toBe("Marina P.");
    expect(nomeCurto("  Pedro  ")).toBe("Pedro");
    expect(nomeCurto("")).toBe("");
  });

  it("com altura para duas linhas: paciente em cima, hora e procedimento embaixo", () => {
    const base = { titulo: "Consulta", paciente: "Marina Alves", hora: "09:30", alturaPx: alturaDe(45) };
    expect(rotuloDoBloco({ ...base, visao: "semana" })).toEqual({
      principal: "Marina A.",
      apoio: "09:30 · Consulta",
    });
    expect(rotuloDoBloco({ ...base, visao: "dia" })).toEqual({
      principal: "Marina Alves",
      apoio: "09:30 · Consulta",
    });
    // 40 min já tem duas linhas (decisão 7 do André, 27/11/2026: curto é ≤ 30).
    expect(rotuloDoBloco({ ...base, alturaPx: alturaDe(40), visao: "dia" })).toEqual({
      principal: "Marina Alves",
      apoio: "09:30 · Consulta",
    });
  });

  it("o corte é a altura desenhada: 34 px tem duas linhas, menos que isso é uma", () => {
    const base = { titulo: "Consulta", paciente: "Marina Alves", hora: "09:30", visao: "dia" as const };
    expect(ALTURA_DE_DUAS_LINHAS).toBe(34);
    expect(rotuloDoBloco({ ...base, alturaPx: 34 }).apoio).toBe("09:30 · Consulta");
    expect(rotuloDoBloco({ ...base, alturaPx: 33.9 }).apoio).toBeNull();
    // Em minutos, com 56 px por hora: 38 min ainda é curto, 39 min já não.
    expect(rotuloDoBloco({ ...base, alturaPx: alturaDe(38) }).apoio).toBeNull();
    expect(rotuloDoBloco({ ...base, alturaPx: alturaDe(39) }).apoio).toBe("09:30 · Consulta");
  });

  it("15 e 30 min: uma linha só, hora na frente do nome", () => {
    for (const min of [15, 30]) {
      expect(
        rotuloDoBloco({ titulo: "Retorno", paciente: "Pedro Lima", hora: "09:15", alturaPx: alturaDe(min), visao: "semana" }),
      ).toEqual({ principal: "09:15 Pedro L.", apoio: null });
    }
  });

  it("sem paciente fica o título", () => {
    expect(rotuloDoBloco({ titulo: "Reunião", hora: "14:00", alturaPx: alturaDe(60), visao: "semana" })).toEqual({
      principal: "Reunião",
      apoio: "14:00",
    });
    expect(rotuloDoBloco({ titulo: "Ocupado", hora: "14:00", alturaPx: alturaDe(30), visao: "dia" })).toEqual({
      principal: "14:00 Ocupado",
      apoio: null,
    });
  });
});
