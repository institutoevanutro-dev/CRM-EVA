/**
 * O DIA DO NEGÓCIO NO CALENDÁRIO DO FUNIL É O DA ORGANIZAÇÃO.
 *
 * O original (upstream #2790) lia o carimbo com `getDate()`, que é o relógio de
 * quem roda o código: o servidor em UTC, o navegador de quem viaja. Um negócio
 * criado às 23:30 em São Paulo (02:30 UTC do dia seguinte) apareceria no dia
 * seguinte para um processo em UTC ou em Tóquio.
 *
 * Por isso a suíte inteira roda TRÊS vezes, com o processo em UTC, em São Paulo
 * e em Tóquio, e cobra a MESMA resposta nas três. O Node relê `process.env.TZ`
 * a cada atribuição, então trocar aqui dentro vale de verdade (a primeira
 * asserção de cada bloco confere que valeu).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CAMPO_CRIACAO,
  CAMPO_FECHAMENTO,
  campoPadrao,
  camposDeData,
  diaDe,
  diasDaSemana,
  diasDoNegocio,
  gradeDoMes,
  hojeNoFuso,
  negociosNoCalendario,
  primeiroDoMes,
  somaDias,
} from "@/lib/kanban/calendario-do-funil";
import type { Lead } from "@/lib/types/leads";

const SP = "America/Sao_Paulo";

function negocio(id: string, parcial: Partial<Lead> = {}): Lead {
  return {
    id,
    organization_id: "org-1",
    pipeline_id: "p-1",
    stage_id: "e-1",
    contact_id: null,
    title: id,
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1,
    value_cents: null,
    currency: null,
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    stage_changed_at: null,
    expected_close_date: null,
    closed_at: null,
    source: "manual",
    source_metadata: {},
    external_id: null,
    custom_fields: {},
    tags: [],
    created_at: "2026-01-01T12:00:00+00:00",
    updated_at: "2026-01-01T12:00:00+00:00",
    created_by_user_id: null,
    ...parcial,
  };
}

const TZ_ORIGINAL = process.env.TZ;
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const OFFSET_ESPERADO: Record<string, number> = { UTC: 0, "America/Sao_Paulo": 180, "Asia/Tokyo": -540 };

describe.each(["UTC", "America/Sao_Paulo", "Asia/Tokyo"])("com o processo em %s", (tz) => {
  beforeAll(() => {
    process.env.TZ = tz;
  });

  it("o processo está mesmo neste fuso (senão o resto não mede nada)", () => {
    expect(new Date(2026, 5, 15).getTimezoneOffset()).toBe(OFFSET_ESPERADO[tz]);
  });

  it("23:30 em São Paulo fica no dia de São Paulo, não no dia seguinte do UTC", () => {
    // 15/03 23:30 em São Paulo = 16/03 02:30 UTC.
    expect(diaDe("2026-03-16T02:30:00+00:00", SP)).toBe("2026-03-15");
    expect(diaDe("2026-03-16T02:30:00Z", SP)).toBe("2026-03-15");
    expect(diaDe("2026-03-15T23:30:00-03:00", SP)).toBe("2026-03-15");
    // O formato de texto do Postgres (espaço, offset curto).
    expect(diaDe("2026-03-16 02:30:00+00", SP)).toBe("2026-03-15");
    // E 00:10 em São Paulo já é o dia novo.
    expect(diaDe("2026-03-16T03:10:00Z", SP)).toBe("2026-03-16");
  });

  it("o mesmo instante cai em dias diferentes conforme o fuso da ORGANIZAÇÃO", () => {
    expect(diaDe("2026-03-16T02:30:00Z", "Asia/Tokyo")).toBe("2026-03-16");
    expect(diaDe("2026-03-16T02:30:00Z", "UTC")).toBe("2026-03-16");
    expect(diaDe("2026-03-16T02:30:00Z", "America/Manaus")).toBe("2026-03-15");
  });

  it("data pura é o próprio dia, e carimbo sem fuso vale o dia escrito", () => {
    expect(diaDe("2026-03-10", SP)).toBe("2026-03-10");
    expect(diaDe("2026-03-10", "Asia/Tokyo")).toBe("2026-03-10");
    expect(diaDe("2026-03-10T23:30:00", SP)).toBe("2026-03-10");
    expect(diaDe("2026-03-10T00:10", "Asia/Tokyo")).toBe("2026-03-10");
  });

  it("o que não é data é null, sem adivinhar", () => {
    for (const lixo of ["", "  ", "2026-02-30", "2026-13-01", "10/03/2026", "amanhã", "2026-03-10Tlixo", 20260310, null, undefined, {}]) {
      expect(diaDe(lixo, SP)).toBeNull();
    }
  });

  it("hoje é o dia da organização", () => {
    const agora = new Date("2026-03-16T02:30:00Z");
    expect(hojeNoFuso(agora, SP)).toBe("2026-03-15");
    expect(hojeNoFuso(agora, "Asia/Tokyo")).toBe("2026-03-16");
  });

  it("a semana começa no domingo e atravessa mês e ano", () => {
    // 15/03/2026 é domingo.
    expect(diasDaSemana("2026-03-15")).toEqual([
      "2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20", "2026-03-21",
    ]);
    // Sábado continua na semana do domingo anterior.
    expect(diasDaSemana("2026-03-21")[0]).toBe("2026-03-15");
    // 31/12/2026 é quinta: a semana vai de 27/12 a 02/01.
    expect(diasDaSemana("2026-12-31")).toEqual([
      "2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02",
    ]);
  });

  it("o negócio das 23:30 de sábado fica na semana de sábado, não na seguinte", () => {
    // Sábado 21/03 23:30 em São Paulo = domingo 22/03 02:30 UTC.
    const dia = diaDe("2026-03-22T02:30:00Z", SP)!;
    expect(dia).toBe("2026-03-21");
    expect(diasDaSemana(dia)[0]).toBe("2026-03-15");
  });

  it("a grade do mês tem os dias certos, com buracos antes e depois", () => {
    // Março de 2026 começa num domingo: sem buraco na frente, 4 atrás.
    const marco = gradeDoMes("2026-03-17");
    expect(marco).toHaveLength(35);
    expect(marco[0]).toBe("2026-03-01");
    expect(marco[30]).toBe("2026-03-31");
    expect(marco.slice(31)).toEqual([null, null, null, null]);
    // Fevereiro de 2028 é bissexto e começa numa terça.
    const fev = gradeDoMes("2028-02-10");
    expect(fev.slice(0, 3)).toEqual([null, null, "2028-02-01"]);
    expect(fev.filter(Boolean)).toHaveLength(29);
    expect(fev.length % 7).toBe(0);
  });

  it("andar de mês e de dia não escorrega", () => {
    expect(primeiroDoMes("2026-01-31", 1)).toBe("2026-02-01");
    expect(primeiroDoMes("2026-01-15", -1)).toBe("2025-12-01");
    expect(somaDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somaDias("2026-03-01", -1)).toBe("2026-02-28");
    // O dia em que o Brasil ENTRAVA no horário de verão (até 2019): sem buraco.
    expect(somaDias("2018-11-03", 1)).toBe("2018-11-04");
    expect(somaDias("2018-11-04", 1)).toBe("2018-11-05");
  });

  it("os campos nativos leem a coluna do negócio", () => {
    const l = negocio("l1", {
      created_at: "2026-03-16T02:30:00+00:00",
      expected_close_date: "2026-04-02",
      custom_fields: { data_inicio: "2026-03-10" },
    });
    expect(diasDoNegocio(l, CAMPO_CRIACAO, null, SP)).toEqual(["2026-03-15"]);
    expect(diasDoNegocio(l, CAMPO_FECHAMENTO, null, SP)).toEqual(["2026-04-02"]);
    expect(diasDoNegocio(l, "data_inicio", null, SP)).toEqual(["2026-03-10"]);
  });
});

describe("os campos que dirigem o calendário", () => {
  it("os de tipo date do funil vêm primeiro, depois os dois nativos", () => {
    const campos = camposDeData({
      fields: [
        { key: "origem", label: "Origem", type: "text" },
        { key: "data_inicio", label: "Data de início", type: "date" },
      ],
    });
    expect(campos.map((c) => c.key)).toEqual(["data_inicio", CAMPO_FECHAMENTO, CAMPO_CRIACAO]);
    expect(campoPadrao(campos)).toBe("data_inicio");
  });

  it("funil sem campo de data abre na data de criação, que todo negócio tem", () => {
    for (const settings of [null, undefined, {}, { fields: "lixo" }]) {
      const campos = camposDeData(settings as Record<string, unknown> | null);
      expect(campos.map((c) => c.key)).toEqual([CAMPO_FECHAMENTO, CAMPO_CRIACAO]);
      expect(campoPadrao(campos)).toBe(CAMPO_CRIACAO);
    }
  });
});

describe("quem aparece em que dia", () => {
  it("leva o negócio ao dia da data e CONTA quem não tem data", () => {
    const leads = [
      negocio("l1", { custom_fields: { data_inicio: "2026-03-10" } }),
      negocio("l2", { custom_fields: { descricao: "nada aqui" } }),
      negocio("l3", { custom_fields: { data_inicio: "2026-02-30" } }),
      negocio("l4", { custom_fields: { data_inicio: "2026-03-10" } }),
    ];
    const { porDia, semData } = negociosNoCalendario(leads, "data_inicio", null, SP);

    expect(porDia.get("2026-03-10")?.map((l) => l.id)).toEqual(["l1", "l4"]);
    expect(semData.map((l) => l.id)).toEqual(["l2", "l3"]);
    // Ninguém some: todo negócio está na grade ou na lista dos sem data.
    expect(new Set([...porDia.values()].flat().map((l) => l.id)).size + semData.length).toBe(leads.length);
  });

  it("com dois campos cobre o intervalo inteiro, e não anda para trás", () => {
    const ida = negocio("l1", { custom_fields: { data_inicio: "2026-03-30", data_fim: "2026-04-02" } });
    const invertida = negocio("l2", { custom_fields: { data_inicio: "2026-03-20", data_fim: "2026-03-18" } });
    expect(diasDoNegocio(ida, "data_inicio", "data_fim", SP)).toEqual([
      "2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02",
    ]);
    expect(diasDoNegocio(invertida, "data_inicio", "data_fim", SP)).toEqual(["2026-03-20"]);
    expect(diasDoNegocio(ida, "data_inicio", null, SP)).toEqual(["2026-03-30"]);
    expect(diasDoNegocio(ida, "data_inicio", "data_inicio", SP)).toEqual(["2026-03-30"]);
  });

  it("intervalo maior que um ano não enche a grade: fica o dia do início", () => {
    const contrato = negocio("l1", { custom_fields: { data_inicio: "2026-03-10", data_fim: "2040-01-01" } });
    expect(diasDoNegocio(contrato, "data_inicio", "data_fim", SP)).toEqual(["2026-03-10"]);
    const umAno = negocio("l2", { custom_fields: { data_inicio: "2026-03-10", data_fim: "2027-03-09" } });
    expect(diasDoNegocio(umAno, "data_inicio", "data_fim", SP)).toHaveLength(365);
  });

  it("5 mil negócios: uma passada, bem abaixo de um quadro de animação lento", () => {
    const leads = Array.from({ length: 5000 }, (_, i) =>
      negocio(`l${i}`, { created_at: new Date(Date.UTC(2026, 0, 1, 0, i * 7)).toISOString() }),
    );
    const t0 = performance.now();
    const { porDia, semData } = negociosNoCalendario(leads, CAMPO_CRIACAO, null, SP);
    const ms = performance.now() - t0;
    expect(semData).toHaveLength(0);
    expect([...porDia.values()].reduce((n, l) => n + l.length, 0)).toBe(5000);
    // Folga larga de propósito (máquina de CI carregada); o medido local é ~10ms.
    expect(ms).toBeLessThan(1000);
  });
});
