import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { lerRegras, REGRAS_PADRAO, regrasSchema } from "./regras";

describe("regras do bônus", () => {
  it("objeto vazio vira a regra padrão: dinheiro zero, quantidades do produto", () => {
    const r = regrasSchema.parse({});
    expect(r.tarefas.valor_cents).toBe(0);
    expect(r.resultados.comparecimento.valor_cents).toBe(0);
    expect(r.rotinas).toEqual({ leads_por_dia: 30, ligacoes_por_dia: 5, stories_por_dia: 2 });
    expect(r.tarefas.faixas).toEqual([
      { minimo_bps: 10_000, fracao_bps: 10_000 },
      { minimo_bps: 9_000, fracao_bps: 5_000 },
    ]);
    expect(r.fila.hora_local).toBe(7);
    expect(r.fila.etiqueta_excluida).toBe("reativacao");
    expect(r.protecao).toEqual({ limite_bps: 500, dias_seguidos: 3, fracao_reduzida_bps: 5_000, intervalo_minimo_s: 20 });
    expect(r.teto_cents).toBeNull();
    expect(REGRAS_PADRAO).toEqual(r);
  });

  it("meta alta menor que a básica é recusada", () => {
    const meta = { basica: 10, alta: 5 };
    const r = regrasSchema.safeParse({
      metas_por_mes: { "2026-12": { comparecimento: meta, sinal_pago: meta, avaliacao_google: meta } },
    });
    expect(r.success).toBe(false);
  });

  it("mês com formato errado é recusado", () => {
    expect(regrasSchema.safeParse({ meses_de_teste: { "2026-13": { garantia_resultados_cents: 1 } } }).success).toBe(false);
  });

  it("participante tem de ser uuid", () => {
    expect(regrasSchema.safeParse({ participantes: ["fulano"] }).success).toBe(false);
    expect(regrasSchema.safeParse({ participantes: [randomUUID()] }).success).toBe(true);
  });

  it("lerRegras nunca lança: jsonb torto vira erro nomeado", () => {
    expect(lerRegras({ teto_cents: "muito" })).toEqual({ ok: false, erro: "teto_cents" });
    expect(lerRegras(null).ok).toBe(true);
  });
});
