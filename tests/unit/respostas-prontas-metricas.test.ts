import { describe, expect, it } from "vitest";

import { resumirAgregado, resumirMetricas } from "@/lib/respostas-prontas/esquemas";

describe("resumirMetricas — a conta da tela de Perguntas frequentes", () => {
  it("turnos de IA são JOBS distintos, não chamadas (um turno faz várias)", () => {
    const m = resumirMetricas(4, [
      { job_id: "j1", cost_cents: 1 },
      { job_id: "j1", cost_cents: 2 },
      { job_id: "j2", cost_cents: "3" },
    ]);
    expect(m.respondidas_pela_ia).toBe(2);
    expect(m.custo_medio_turno_cents).toBe(3);
    expect(m.custo_evitado_estimado_cents).toBe(12);
    expect(m.custo_incompleto).toBe(false);
  });

  it("sem turno de IA no período, não inventa custo", () => {
    const m = resumirMetricas(5, []);
    expect(m).toEqual({
      resolvidas_por_resposta_pronta: 5,
      respondidas_pela_ia: 0,
      custo_medio_turno_cents: null,
      custo_evitado_estimado_cents: null,
      custo_incompleto: false,
    });
  });

  it("preço desconhecido (cost_cents null) é sinalizado, nunca somado como zero silencioso", () => {
    const m = resumirMetricas(1, [
      { job_id: "j1", cost_cents: null },
      { job_id: "j2", cost_cents: 4 },
    ]);
    expect(m.custo_incompleto).toBe(true);
    expect(m.respondidas_pela_ia).toBe(2);
  });

  it("chamada sem job (teste de conexão) não conta como turno", () => {
    expect(resumirMetricas(0, [{ job_id: null, cost_cents: 9 }]).respondidas_pela_ia).toBe(0);
  });

  it("o agregado vindo do banco dá a mesma conta (RPC não corta em 1000 linhas)", () => {
    expect(resumirAgregado(4, 2, "6", false)).toEqual(
      resumirMetricas(4, [
        { job_id: "j1", cost_cents: 3 },
        { job_id: "j2", cost_cents: 3 },
      ]),
    );
  });
});
