/**
 * TEXTO DE RESERVA NA VARIÁVEL: `{{primeiro_nome|"aluno"}}`.
 *
 * Portado do projeto original (DeskcommCRM, PR #3535 de @melgarafael, a partir
 * do #3405 de @xxfabioxx12). Sem o dado, sai o texto entre aspas; com o dado, a
 * reserva é ignorada; sem `|`, nada muda. Medido nos quatro renderizadores do
 * fork: Inbox/follow-up, automação, campanha e modelos da operação.
 */
import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/automation/template";
import { renderizar } from "@/lib/campanhas/renderizador";
import { interpolateTemplate, motivoDoCuringaLiteral, variaveisDesconhecidas } from "@/lib/inbox/template-vars";

const SEM_NOME = {};
const COM_NOME = { name: "Maria Teste" };

describe("Inbox e follow-up (interpolateTemplate)", () => {
  it("sem nome, sai a reserva; com nome, a reserva some", () => {
    expect(interpolateTemplate('Oi {{primeiro_nome|"aluno"}}!', SEM_NOME)).toBe("Oi aluno!");
    expect(interpolateTemplate('Oi {{primeiro_nome|"aluno"}}!', COM_NOME)).toBe("Oi Maria!");
  });

  it("aspas curvas valem, e em `remover` a reserva também cobre", () => {
    expect(interpolateTemplate("Oi {{nome|“aluno”}}!", SEM_NOME)).toBe("Oi aluno!");
    expect(interpolateTemplate('Oi {{nome|"aluno"}}, tudo bem?', SEM_NOME, { semValor: "remover" })).toBe(
      "Oi aluno, tudo bem?",
    );
  });

  it("a marcação com reserva não é variável desconhecida nem curinga literal", () => {
    expect(variaveisDesconhecidas('Oi {{primeiro_nome|"aluno"}}')).toEqual([]);
    expect(motivoDoCuringaLiteral('Oi {{primeiro_nome|"aluno"}}', SEM_NOME)).toBeNull();
  });

  it("sem `|`, o comportamento é o de antes", () => {
    expect(interpolateTemplate("Oi {{primeiro_nome}}!", SEM_NOME)).toBe("Oi {{primeiro_nome}}!");
  });
});

describe("automação (renderTemplate)", () => {
  it("sem o dado, a reserva; com o dado, o valor", () => {
    expect(renderTemplate('Oi {{primeiro_nome|"aluno"}}!', { contact: {} })).toBe("Oi aluno!");
    expect(renderTemplate('E-mail: {{email|"sem e-mail"}}', { contact: {} })).toBe("E-mail: sem e-mail");
    expect(renderTemplate('Oi {{primeiro_nome|"aluno"}}!', { contact: { name: "Maria Teste" } })).toBe("Oi Maria!");
  });

  it("a reserva não passa pelo formatador de valor (é texto do operador)", () => {
    const html = renderTemplate('Oi {{nome|"<b>aluno</b>"}}', { contact: {} }, (v) => v.replace(/</g, "&lt;"));
    expect(html).toBe("Oi <b>aluno</b>");
  });
});

describe("campanha (renderizar)", () => {
  it("com reserva, quem não tem nome não fica de fora", () => {
    const r = renderizar('Oi {{primeiro_nome|"aluno"}}!', { nome: null });
    expect(r.texto).toBe("Oi aluno!");
    expect(r.faltando).toEqual([]);
  });

  it("sem reserva, continua faltando", () => {
    expect(renderizar("Oi {{primeiro_nome}}!", { nome: null }).faltando).toEqual(["primeiro_nome"]);
  });
});
