import { describe, expect, it } from "vitest";

import { CHAVE_DO_TIPO_DE_RECURSO_V4, montarExtras, TIPO_DE_RECURSO_COEXISTENCIA } from "./coexistencia";

describe("extras da v4", () => {
  it("leva setup vazio, o tipo de recurso sob a chave conferida e sessionInfoVersion 3 (exemplo oficial de 01/10/2026)", () => {
    expect(montarExtras()).toEqual({
      setup: {},
      [CHAVE_DO_TIPO_DE_RECURSO_V4]: TIPO_DE_RECURSO_COEXISTENCIA,
      sessionInfoVersion: "3",
    });
  });
  it("a chave foi conferida (não é o placeholder)", () => {
    expect(["featureType", "feature_type"]).toContain(CHAVE_DO_TIPO_DE_RECURSO_V4);
  });
});
