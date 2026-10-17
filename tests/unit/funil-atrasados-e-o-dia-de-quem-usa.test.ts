/**
 * "APENAS ATRASADOS" DO FUNIL USA O DIA DE QUEM OLHA A TELA — NÃO O DIA UTC.
 *
 * Portado do projeto original (DeskcommCRM, PR #2943 de @webtecnica). Lá eram
 * quatro telas; neste repositório só o funil tem o defeito (Faturamento e
 * Proposta nova não existem aqui).
 *
 * `new Date().toISOString().slice(0, 10)` é o dia UTC. Às 23:30 em Brasília o
 * UTC já virou, e o filtro marcava como atrasado o negócio que fecha HOJE.
 * Fuso e instante são FIXOS, e um caso DISCRIMINADOR garante que, neste
 * instante, dia local e dia UTC divergem — sem ele, um runner em UTC não
 * distinguiria o conserto do defeito.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { diaDeHojeLocal } from "@/lib/ai/pacing-knobs";
import { applyFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

/** 23:30 de 30/09/2026 em Brasília = 02:30 de 01/10/2026 em UTC. */
const INSTANTE_23H30_BRT = "2026-10-01T02:30:00.000Z";
const DIA_DE_QUEM_USA = "2026-09-30";
const DIA_UTC = "2026-10-01";

const TZ_ORIGINAL = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

function relogio(fuso: string, instante: string): void {
  process.env.TZ = fuso;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instante));
}

const lead = (id: string, campos: Partial<Lead> = {}): Lead =>
  ({
    id,
    title: id,
    status: "open",
    owner_user_id: "u1",
    owner_agent_id: null,
    tags: [],
    conversation_tags: [],
    contact_tags: [],
    ...campos,
  }) as Lead;

describe("às 23:30 em Brasília, 'Apenas atrasados' usa o dia de quem olha o funil", () => {
  it("DISCRIMINADOR: o dia local e o dia UTC divergem neste instante", () => {
    relogio("America/Sao_Paulo", INSTANTE_23H30_BRT);
    expect(diaDeHojeLocal()).toBe(DIA_DE_QUEM_USA);
    expect(new Date().toISOString().slice(0, 10)).toBe(DIA_UTC);
  });

  it("NÃO marca como atrasado o negócio que fecha HOJE", () => {
    relogio("America/Sao_Paulo", INSTANTE_23H30_BRT);
    const atrasados = applyFilters(
      [
        lead("fecha-hoje", { expected_close_date: DIA_DE_QUEM_USA }),
        lead("fechou-ontem", { expected_close_date: "2026-09-29" }),
        lead("fecha-amanha", { expected_close_date: DIA_UTC }),
      ],
      { overdueOnly: true },
    );
    expect(atrasados.map((l) => l.id)).toEqual(["fechou-ontem"]);
  });

  it("controle: com o navegador em UTC, nada muda", () => {
    relogio("UTC", INSTANTE_23H30_BRT);
    const atrasados = applyFilters(
      [
        lead("fecha-hoje", { expected_close_date: DIA_UTC }),
        lead("fechou-ontem", { expected_close_date: DIA_DE_QUEM_USA }),
      ],
      { overdueOnly: true },
    );
    expect(atrasados.map((l) => l.id)).toEqual(["fechou-ontem"]);
  });
});
