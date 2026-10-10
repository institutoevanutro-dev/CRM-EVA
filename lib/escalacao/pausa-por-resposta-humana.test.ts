import { describe, expect, it } from "vitest";

import {
  PAUSA_MAXIMA_MIN,
  PAUSA_MINIMA_MIN,
  PAUSA_PADRAO_MIN,
  carregarPausaPorRespostaHumanaMs,
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

  it("settings nulo vira objeto com a pausa", () => {
    expect(lerPausaPorRespostaHumanaMin(settingsComPausaPorRespostaHumana(null, 30))).toBe(30);
  });
});

describe("carregarPausaPorRespostaHumanaMs", () => {
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
});
