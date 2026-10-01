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

import { dentroDoPrazoDeSincronizacao, lerCoexistencia, mensagemDoErroDaMeta } from "./coexistencia";

describe("prazo de sincronização", () => {
  const t0 = "2026-10-10T12:00:00.000Z";
  it("23h59 depois ainda vale; 24h depois não", () => {
    expect(dentroDoPrazoDeSincronizacao(t0, new Date("2026-10-11T11:59:59.000Z"))).toBe(true);
    expect(dentroDoPrazoDeSincronizacao(t0, new Date("2026-10-11T12:00:00.000Z"))).toBe(false);
  });
  it("data inválida nunca está no prazo", () => {
    expect(dentroDoPrazoDeSincronizacao("lixo")).toBe(false);
  });
});
describe("erros conhecidos da Meta", () => {
  it("3441041 explica o número preso em outra WABA", () => {
    expect(mensagemDoErroDaMeta(3441041, null, "x")).toMatch(/outra conta do WhatsApp Business/);
  });
  it("o subcódigo também é consultado", () => {
    expect(mensagemDoErroDaMeta(100, 2655093, "x")).toMatch(/15 minutos/);
  });
  it("desconhecido devolve o padrão", () => {
    expect(mensagemDoErroDaMeta(999, null, "padrão")).toBe("padrão");
  });
});
describe("lerCoexistencia", () => {
  it("devolve null sem a chave e o objeto quando há onboarding_em", () => {
    expect(lerCoexistencia({ ai_gate: "allowlist" })).toBeNull();
    expect(lerCoexistencia({ coexistencia: { onboarding_em: "2026-10-10T12:00:00.000Z", pedidos: { contatos: null, historico: null }, historico: null } })?.onboarding_em).toBe("2026-10-10T12:00:00.000Z");
  });
});
