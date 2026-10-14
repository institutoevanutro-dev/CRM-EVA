/**
 * O HORÁRIO LIVRE SAI COM A UNIDADE DA JANELA QUE O GEROU.
 *
 * Medido em produção (Instituto Eva, 14/10/2026): todo tipo presencial exige
 * sala, o gatilho do compromisso recusa sem `unit_id`
 * (`agenda_unidade_obrigatoria`), e os horários livres chegavam com
 * `unit_id: null` embora a jornada tivesse a unidade em todas as janelas. A IA
 * não tinha de onde tirar a unidade e não conseguia marcar.
 */
import { describe, expect, it } from "vitest";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { horariosLivres, type Slot, type TipoDeAgendamento } from "@/lib/agenda/horarios-livres";

const SP = "America/Sao_Paulo";
const VITORIA = "ea730000-0000-4000-8000-000000000001";
const SERRA = "ea730000-0000-4000-8000-000000000002";

const TIPO_50: TipoDeAgendamento = {
  duracaoMin: 50,
  bufferAntesMin: 0,
  bufferDepoisMin: 0,
  avisoMinimoMin: 0,
  intervaloMin: null,
  janelaDias: 60,
};

/** 2026-03-09 é uma segunda-feira. */
const SEGUNDA = { de: new Date("2026-03-09T00:00:00Z"), ate: new Date("2026-03-10T02:59:59Z") };
const AGORA = new Date("2026-03-01T12:00:00Z");

function legivel(slots: Slot[]): string[] {
  return slots.map((s) => {
    const p = partesNoFuso(s.inicio, SP);
    const hora = `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
    return `${hora} ${s.unitId === VITORIA ? "vitoria" : s.unitId === SERRA ? "serra" : "sem"}`;
  });
}

describe("a unidade viaja da janela até o horário", () => {
  it("cada horário leva a unidade da janela da jornada", () => {
    const slots = horariosLivres({
      jornada: { timezone: SP, windows: [{ dow: 1, start: "09:00", end: "11:00", unit_id: VITORIA }] },
      excecoes: [],
      ocupados: [],
      tipo: TIPO_50,
      ...SEGUNDA,
      agora: AGORA,
    });
    expect(legivel(slots)).toEqual(["09:00 vitoria", "09:50 vitoria"]);
  });

  it("janela sem unidade continua gerando horário sem unidade, como antes", () => {
    const slots = horariosLivres({
      jornada: { timezone: SP, windows: [{ dow: 1, start: "09:00", end: "11:00" }] },
      excecoes: [],
      ocupados: [],
      tipo: TIPO_50,
      ...SEGUNDA,
      agora: AGORA,
    });
    expect(legivel(slots)).toEqual(["09:00 sem", "09:50 sem"]);
    expect(slots.every((s) => s.unitId === null)).toBe(true);
  });

  it("janelas encostadas de unidades diferentes NÃO se fundem: cada uma ancora a própria grade", () => {
    // Fundidas, a grade de Vitória atravessaria a emenda e o 12:20 sairia com
    // uma unidade só — metade dele é da Serra, e a sala reservada seria a errada.
    const slots = horariosLivres({
      jornada: {
        timezone: SP,
        windows: [
          { dow: 1, start: "09:00", end: "12:00", unit_id: VITORIA },
          { dow: 1, start: "12:00", end: "14:00", unit_id: SERRA },
        ],
      },
      excecoes: [],
      ocupados: [],
      tipo: TIPO_50,
      ...SEGUNDA,
      agora: AGORA,
    });
    expect(legivel(slots)).toEqual([
      "09:00 vitoria",
      "09:50 vitoria",
      "10:40 vitoria",
      "12:00 serra",
      "12:50 serra",
    ]);
  });

  it("janelas sobrepostas de duas unidades oferecem o mesmo instante nas DUAS, para a escolha ser explícita", () => {
    const slots = horariosLivres({
      jornada: {
        timezone: SP,
        windows: [
          { dow: 1, start: "09:00", end: "10:00", unit_id: VITORIA },
          { dow: 1, start: "09:00", end: "10:00", unit_id: SERRA },
        ],
      },
      excecoes: [],
      ocupados: [],
      tipo: TIPO_50,
      ...SEGUNDA,
      agora: AGORA,
    });
    expect(legivel(slots).sort()).toEqual(["09:00 serra", "09:00 vitoria"]);
  });

  it("sem intervalo configurado o passo é a duração do tipo, e não 5 minutos", () => {
    const slots = horariosLivres({
      jornada: { timezone: SP, windows: [{ dow: 1, start: "13:00", end: "15:00", unit_id: VITORIA }] },
      excecoes: [],
      ocupados: [],
      tipo: TIPO_50,
      ...SEGUNDA,
      agora: AGORA,
    });
    expect(legivel(slots)).toEqual(["13:00 vitoria", "13:50 vitoria"]);
  });
});
