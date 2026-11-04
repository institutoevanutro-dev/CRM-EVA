import { describe, expect, it } from "vitest";

import {
  PAUSA_MAXIMA_MIN,
  PAUSA_MINIMA_MIN,
  PAUSA_PADRAO_MIN,
  carregarPrazoDaPausa,
  fimDoDiaSeguinte,
  lerIaVoltaAposEquipe,
  prazoDaPausa,
  settingsComIaVoltaAposEquipe,
  lerPausaPorRespostaHumanaMin,
  settingsComPausaPorRespostaHumana,
} from "./pausa-por-resposta-humana";

const com = (v: unknown) => ({ atendimento: { pausa_ia_resposta_humana_min: v } });

describe("lerPausaPorRespostaHumanaMin", () => {
  it("o padrão é 5 minutos, e a faixa vai de 5 minutos a 24 horas", () => {
    expect(PAUSA_PADRAO_MIN).toBe(5);
    expect(PAUSA_MINIMA_MIN).toBe(5);
    expect(PAUSA_MAXIMA_MIN).toBe(1440);
  });

  it.each([null, undefined, {}, { atendimento: null }, { atendimento: {} }, "texto", 7])(
    "sem o ajuste (%j) vale o padrão: clone antigo não muda",
    (settings) => {
      expect(lerPausaPorRespostaHumanaMin(settings)).toBe(5);
    },
  );

  it("devolve o valor da organização, inclusive nas duas pontas", () => {
    expect(lerPausaPorRespostaHumanaMin(com(5))).toBe(5);
    expect(lerPausaPorRespostaHumanaMin(com(120))).toBe(120);
    expect(lerPausaPorRespostaHumanaMin(com(1440))).toBe(1440);
  });

  it.each([4, 0, -30, 1441, 99999, 7.5, "120", null, Number.NaN, Number.POSITIVE_INFINITY, {}])(
    "valor inválido (%j) cai no padrão, nunca vira prazo",
    (v) => {
      expect(lerPausaPorRespostaHumanaMin(com(v))).toBe(5);
    },
  );
});

describe("settingsComPausaPorRespostaHumana", () => {
  it("troca só a pausa: o resto de settings e de atendimento sobrevive", () => {
    const antes = { routing: { mode: "manual" }, atendimento: { outra: 1, pausa_ia_resposta_humana_min: 5 } };
    expect(settingsComPausaPorRespostaHumana(antes, 90)).toEqual({
      routing: { mode: "manual" },
      atendimento: { outra: 1, pausa_ia_resposta_humana_min: 90 },
    });
  });

  it.each([
    ["settings string", "abc"],
    ["settings array", [1, 2]],
    ["atendimento string", { routing: 1, atendimento: "abc" }],
    ["atendimento array", { routing: 1, atendimento: [1, 2] }],
  ])("%s não é espalhado: nada de chaves 0, 1, 2 no jsonb", (_nome, torto) => {
    const novo = settingsComPausaPorRespostaHumana(torto, 60);
    expect(novo.atendimento).toEqual({ pausa_ia_resposta_humana_min: 60 });
    expect(Object.keys(novo).sort()).toEqual(
      typeof torto === "object" && !Array.isArray(torto) ? ["atendimento", "routing"] : ["atendimento"],
    );
  });

  it("settings nulo vira objeto com a pausa", () => {
    expect(lerPausaPorRespostaHumanaMin(settingsComPausaPorRespostaHumana(null, 30))).toBe(30);
  });
});

describe("carregarPrazoDaPausa (modo em minutos)", () => {
  const T0 = new Date("2026-11-03T20:11:00Z");
  const carregarPausaPorRespostaHumanaMs = async (s: never, o: string, f?: (d: string) => void) =>
    (await carregarPrazoDaPausa(s, o, T0, f)).getTime() - T0.getTime();
  const stub = (resposta: () => Promise<unknown>) => {
    const filtros: Array<[string, unknown]> = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      maybeSingle: resposta,
    };
    return { supabase: { from: () => q } as never, filtros };
  };

  it("lê a organização pedida e devolve em milissegundos", async () => {
    const { supabase, filtros } = stub(async () => ({ data: { settings: com(120) }, error: null }));
    expect(await carregarPausaPorRespostaHumanaMs(supabase, "org-1")).toBe(120 * 60 * 1000);
    expect(filtros).toEqual([["id", "org-1"]]);
  });

  it("erro do banco, linha ausente ou exceção: padrão, sem lançar", async () => {
    const padrao = 5 * 60 * 1000;
    expect(await carregarPausaPorRespostaHumanaMs(stub(async () => ({ data: null, error: { message: "x" } })).supabase, "o")).toBe(padrao);
    expect(await carregarPausaPorRespostaHumanaMs(stub(async () => ({ data: null, error: null })).supabase, "o")).toBe(padrao);
    expect(await carregarPausaPorRespostaHumanaMs(stub(async () => { throw new Error("rede"); }).supabase, "o")).toBe(padrao);
    expect(await carregarPausaPorRespostaHumanaMs({ from: () => { throw new Error("sem tabela"); } } as never, "o")).toBe(padrao);
  });

  it("a falha de leitura avisa quem chamou (erro e exceção); leitura boa não avisa", async () => {
    const avisos: string[] = [];
    const avisar = (d: string) => void avisos.push(d);
    await carregarPausaPorRespostaHumanaMs(stub(async () => ({ data: null, error: { message: "timeout" } })).supabase, "o", avisar);
    await carregarPausaPorRespostaHumanaMs(stub(async () => { throw new Error("rede"); }).supabase, "o", avisar);
    await carregarPausaPorRespostaHumanaMs(stub(async () => ({ data: { settings: {} }, error: null })).supabase, "o", avisar);
    expect(avisos).toEqual(["timeout", "rede"]);
  });
});

describe("IA volta no fim do dia seguinte depois que a equipe fala", () => {
  const SP = "America/Sao_Paulo";
  const ligado = { atendimento: { ia_volta_apos_equipe: "fim_do_dia_seguinte", pausa_ia_resposta_humana_min: 120 } };

  it("fala às 17:11 de 03/11 (BRT) → meia-noite de 05/11 local", () => {
    expect(fimDoDiaSeguinte(new Date("2026-11-03T20:11:00Z"), SP).toISOString()).toBe("2026-11-05T03:00:00.000Z");
  });

  it("23:59 local ainda é o dia D: vai a D+2 00:00, não D+3", () => {
    expect(fimDoDiaSeguinte(new Date("2026-11-04T02:59:00Z"), SP).toISOString()).toBe("2026-11-05T03:00:00.000Z");
  });

  it("vira o mês: 30/11 → 02/12 00:00", () => {
    expect(fimDoDiaSeguinte(new Date("2026-11-30T15:00:00Z"), SP).toISOString()).toBe("2026-12-02T03:00:00.000Z");
  });

  it("respeita o fuso da organização (Manaus, UTC-4) e cai no padrão com fuso torto", () => {
    expect(fimDoDiaSeguinte(new Date("2026-11-03T20:11:00Z"), "America/Manaus").toISOString()).toBe("2026-11-05T04:00:00.000Z");
    expect(fimDoDiaSeguinte(new Date("2026-11-03T20:11:00Z"), "São Paulo").toISOString()).toBe("2026-11-05T03:00:00.000Z");
  });

  it.each([null, {}, { atendimento: {} }, { atendimento: { ia_volta_apos_equipe: "sim" } }, { atendimento: { ia_volta_apos_equipe: true } }])(
    "chave ausente ou torta (%j) = desligado",
    (settings) => {
      expect(lerIaVoltaAposEquipe(settings)).toBeNull();
      expect(prazoDaPausa(settings, SP, new Date("2026-11-03T20:11:00Z")).toISOString()).toBe("2026-11-03T20:16:00.000Z");
    },
  );

  it("ligado: o prazo é o fim do dia seguinte, não agora + minutos", () => {
    expect(lerIaVoltaAposEquipe(ligado)).toBe("fim_do_dia_seguinte");
    expect(prazoDaPausa(ligado, SP, new Date("2026-11-03T20:11:00Z")).toISOString()).toBe("2026-11-05T03:00:00.000Z");
  });

  it("settingsComIaVoltaAposEquipe troca só a chave; null desliga", () => {
    const antes = { routing: { x: 1 }, atendimento: { pausa_ia_resposta_humana_min: 120 } };
    const depois = settingsComIaVoltaAposEquipe(antes, "fim_do_dia_seguinte");
    expect(depois).toEqual({ routing: { x: 1 }, atendimento: { pausa_ia_resposta_humana_min: 120, ia_volta_apos_equipe: "fim_do_dia_seguinte" } });
    expect(lerIaVoltaAposEquipe(settingsComIaVoltaAposEquipe(depois, null))).toBeNull();
  });

  it("carregarPrazoDaPausa lê settings e fuso da organização; falha cai no padrão em minutos", async () => {
    const q = (resposta: unknown) => {
      const o = { select: () => o, eq: () => o, maybeSingle: async () => resposta };
      return { from: () => o } as never;
    };
    const agora = new Date("2026-11-03T20:11:00Z");
    expect((await carregarPrazoDaPausa(q({ data: { settings: ligado, timezone: SP }, error: null }), "o", agora)).toISOString())
      .toBe("2026-11-05T03:00:00.000Z");
    const avisos: string[] = [];
    expect((await carregarPrazoDaPausa(q({ data: null, error: { message: "x" } }), "o", agora, (d) => void avisos.push(d))).toISOString())
      .toBe("2026-11-03T20:16:00.000Z");
    expect(avisos).toEqual(["x"]);
  });
});
