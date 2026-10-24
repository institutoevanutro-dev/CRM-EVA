import { describe, expect, it } from "vitest";

import { chavesAlteradas, papelNoPrograma, podeCriarPrograma } from "./acesso";

describe("acesso ao programa", () => {
  const programa = { aprovadorUserId: "apr", regras: { participantes: ["a", "b"] } };

  it("o aprovador é uma pessoa, não um papel", () => {
    expect(papelNoPrograma(programa, "apr")).toEqual({ aprovador: true, participante: false });
    expect(papelNoPrograma(programa, "a")).toEqual({ aprovador: false, participante: true });
    expect(papelNoPrograma(programa, "outro")).toEqual({ aprovador: false, participante: false });
  });

  it("cria o programa: o dono da organização ou o platform admin pleno fora do suporte", () => {
    expect(podeCriarPrograma({ id: "dono", is_platform_admin: false }, "dono")).toBe(true);
    expect(podeCriarPrograma({ id: "admin-qualquer", is_platform_admin: false }, "dono")).toBe(false);
    expect(podeCriarPrograma({ id: "p", is_platform_admin: true, platform_admin_scope: "full" }, "dono")).toBe(true);
    expect(podeCriarPrograma({ id: "p", is_platform_admin: true, platform_admin_scope: "support_readonly" }, "dono")).toBe(false);
    expect(podeCriarPrograma({ id: "p", is_platform_admin: true, platform_admin_scope: "full", support: { status: "active" } }, "dono")).toBe(false);
  });

  it("a auditoria leva só as CHAVES que mudaram, nunca os valores", () => {
    expect(chavesAlteradas({ teto_cents: 1, feriados: [] }, { teto_cents: 2, feriados: [] })).toEqual(["teto_cents"]);
  });
});
