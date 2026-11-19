import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "./actions";
import { AREAS_DA_AUDITORIA, fraseDaAcao } from "./frase";

describe("fraseDaAcao", () => {
  it("verbo genérico + objeto da área", () => {
    expect(fraseDaAcao("lead.created")).toEqual({ verbo: "criou", objeto: "um negócio" });
  });

  it("frase própria vence a genérica", () => {
    expect(fraseDaAcao("contact.viewed")).toEqual({ verbo: "abriu a ficha de um contato" });
    expect(fraseDaAcao("auth.login_success")).toEqual({ verbo: "entrou no sistema" });
  });

  it("sem tradução segura devolve null (a tela mostra o código)", () => {
    expect(fraseDaAcao("relogio.tick_run")).toBeNull();
    expect(fraseDaAcao("lead.reactivation_proposed")).toBeNull();
    expect(fraseDaAcao("sem-ponto")).toBeNull();
  });

  it("toda área do filtro existe no vocabulário de auditoria", () => {
    for (const area of Object.keys(AREAS_DA_AUDITORIA)) {
      expect(AUDIT_ACTIONS.some((a) => a.startsWith(`${area}.`))).toBe(true);
    }
  });
});
