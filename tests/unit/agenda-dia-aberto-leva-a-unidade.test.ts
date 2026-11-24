import { describe, expect, it } from "vitest";

import { horariosLivres, type ExcecaoDeData, type Ocupado } from "@/lib/agenda/horarios-livres";

/**
 * O DIA ABERTO LEVA A UNIDADE (migration 0433), e a ocupação copiada de fora não
 * abre vaga.
 *
 * A rotina que motivou: segunda a sexta numa unidade (a "de sempre"), e datas
 * avulsas, lançadas por mês, em outra unidade ou num sábado com outro horário.
 * Depois da última data lançada, nada é presumido. Unidades e datas fictícias.
 */
const FUSO = "America/Sao_Paulo";
const SEDE = "11111111-1111-4111-8111-111111111111";
const FILIAL = "22222222-2222-4222-8222-222222222222";
const jornada = {
  timezone: FUSO,
  // Segunda a sexta, 10:00–19:30, na sede.
  windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "10:00", end: "19:30", unit_id: SEDE })),
};
const tipo = { duracaoMin: 90, bufferAntesMin: 0, bufferDepoisMin: 0, avisoMinimoMin: 0, intervaloMin: 30, janelaDias: 90 };
const AGORA = new Date("2026-11-30T03:00:00.000Z");

const abrir = (data: string, de: number, ate: number, unidadeId: string | null): ExcecaoDeData => ({
  data,
  indisponivel: false,
  inicioMinuto: de,
  fimMinuto: ate,
  unidadeId,
});

function doDia(dia: string, excecoes: ExcecaoDeData[], ocupados: Ocupado[] = []) {
  return horariosLivres({
    jornada,
    excecoes,
    ocupados,
    tipo,
    de: new Date(`${dia}T03:00:00.000Z`),
    ate: new Date(new Date(`${dia}T03:00:00.000Z`).getTime() + 86_400_000),
    agora: AGORA,
  });
}

const hora = (s: { inicio: Date }) =>
  s.inicio.toLocaleTimeString("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });

describe("o dia aberto em outra unidade", () => {
  // 02/12/2026 é quarta.
  const naFilial = [abrir("2026-12-02", 8 * 60, 18 * 60, FILIAL)];

  it("substitui a jornada do dia: os horários são da filial, nenhum da sede", () => {
    const slots = doDia("2026-12-02", naFilial);
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s) => s.unitId))).toEqual(new Set([FILIAL]));
    expect(hora(slots[0]!)).toBe("08:00");
  });

  it("CONTROLE: sem a data lançada, o dia é da sede, com a jornada de sempre", () => {
    const slots = doDia("2026-12-02", []);
    expect(new Set(slots.map((s) => s.unitId))).toEqual(new Set([SEDE]));
    expect(hora(slots[0]!)).toBe("10:00");
  });

  it("o dia aberto sem unidade segue como antes (null)", () => {
    const slots = doDia("2026-12-02", [abrir("2026-12-02", 8 * 60, 12 * 60, null)]);
    expect(new Set(slots.map((s) => s.unitId))).toEqual(new Set([null]));
  });

  it("manhã numa unidade e tarde noutra não se fundem", () => {
    const slots = doDia("2026-12-02", [abrir("2026-12-02", 8 * 60, 12 * 60, FILIAL), abrir("2026-12-02", 12 * 60, 16 * 60, SEDE)]);
    const atravessa = slots.find((s) => hora(s) === "11:00");
    expect(atravessa, "um horário das 11:00 às 12:30 atravessaria a troca de unidade").toBeUndefined();
  });
});

describe("o sábado lançado com outro horário", () => {
  // 05/12/2026 é sábado: fora da jornada; só existe se for lançado.
  const sabado = [abrir("2026-12-05", 9 * 60, 14 * 60, SEDE)];

  it("sem a data lançada, sábado não tem horário (nada é presumido)", () => {
    expect(doDia("2026-12-05", [])).toEqual([]);
  });

  it("ocupação copiada que passa da faixa (08:00–14:30) não quebra e não abre vaga fora dela", () => {
    const ocupados = [
      { inicio: new Date("2026-12-05T11:00:00.000Z"), fim: new Date("2026-12-05T13:00:00.000Z") }, // 08:00–10:00
      { inicio: new Date("2026-12-05T15:30:00.000Z"), fim: new Date("2026-12-05T17:30:00.000Z") }, // 12:30–14:30
    ];
    const slots = doDia("2026-12-05", sabado, ocupados);
    expect(slots.map(hora)).toEqual(["10:00", "10:30", "11:00"]);
    expect(slots.every((s) => s.unitId === SEDE)).toBe(true);
  });
});
