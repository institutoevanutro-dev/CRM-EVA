import { describe, expect, it } from "vitest";

import { agruparFunilPorPipeline } from "./funil-por-pipeline";

const etapa = (id: string, count = 1, position = 1) => ({
  stage_id: id,
  stage_name: `Etapa ${id}`,
  position,
  count,
});

describe("agruparFunilPorPipeline", () => {
  const info = [
    { id: "a1", pipeline_id: "A", is_won: false, is_lost: false },
    { id: "a-ganho", pipeline_id: "A", is_won: true, is_lost: false },
    { id: "a-perdido", pipeline_id: "A", is_won: false, is_lost: true },
    { id: "b1", pipeline_id: "B", is_won: false, is_lost: false },
  ];
  const funis = [
    { id: "B", name: "Pacientes", is_default: false, position: 1 },
    { id: "A", name: "Atendimento", is_default: true, position: 2 },
  ];

  it("separa por funil, padrão primeiro, sem as etapas de ganho e perda", () => {
    const r = agruparFunilPorPipeline(
      [etapa("a1", 3), etapa("a-ganho", 0), etapa("a-perdido", 0), etapa("b1", 2)],
      info,
      funis,
    );
    expect(r.map((f) => f.pipeline_name)).toEqual(["Atendimento", "Pacientes"]);
    expect(r[0]!.etapas.map((e) => e.stage_id)).toEqual(["a1"]);
    expect(r[1]!.etapas.map((e) => e.count)).toEqual([2]);
  });

  it("ignora etapa sem informação (arquivada) e funil sem etapa aberta", () => {
    const r = agruparFunilPorPipeline([etapa("b1"), etapa("x")], info, funis);
    expect(r.map((f) => f.pipeline_id)).toEqual(["B"]);
  });
});
