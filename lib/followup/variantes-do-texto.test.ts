import { describe, expect, it } from "vitest";

import { turnPayloadExtras } from "./engine";
import { actionConfigSchema, type FlowGraph, type FlowNode } from "./graph-schema";
import { validateFlowForPublish } from "./validate-publish";

/**
 * Variantes do passo `text`: o paciente recebe UMA redação, sempre a mesma para
 * aquele passo, e pacientes diferentes se espalham entre elas — sem IA.
 */

const BODY = "Oi, {{primeiro_nome}}! Como foi a consulta?";
const VARIANTES = ["E aí, {{primeiro_nome}}, como você está depois da consulta?", "{{saudacao}}! Passando para saber como você ficou."];

const texto = (variants?: string[], id = "a1"): FlowNode => ({
  id,
  type: "action",
  label: "Pós-consulta",
  position: { x: 0, y: 0 },
  config: { mode: "text", body: BODY, ...(variants ? { variants } : {}) },
});

const contato = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("schema do passo text com variantes", () => {
  it("sem variantes continua válido (fluxo antigo intocado)", () => {
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY }).success).toBe(true);
  });
  it("aceita de 2 a 5 variantes", () => {
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a", "b"] }).success).toBe(true);
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a", "b", "c", "d", "e"] }).success).toBe(true);
  });
  it("recusa 1 ou 6 variantes", () => {
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a"] }).success).toBe(false);
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });
  it("recusa variante vazia depois do trim e acima de 4000", () => {
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a", "   \n"] }).success).toBe(false);
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a", "x".repeat(4001)] }).success).toBe(false);
    expect(actionConfigSchema.safeParse({ mode: "text", body: BODY, variants: ["a", "x".repeat(4000)] }).success).toBe(true);
  });
  it("variants não existe nos outros modos (strict)", () => {
    expect(
      actionConfigSchema.safeParse({ mode: "template", template_id: contato(1), variants: ["a", "b"] }).success,
    ).toBe(false);
  });
});

describe("escolha determinística por (contato, nó)", () => {
  it("sem variantes: sai o body e o payload não leva `variante`", () => {
    const out = turnPayloadExtras(texto(), [], [], contato(1));
    expect(out).toEqual({ fixed_body: BODY });
  });

  it("o mesmo contato recebe sempre a mesma redação do mesmo passo", () => {
    const a = turnPayloadExtras(texto(VARIANTES), [], [], contato(7));
    const b = turnPayloadExtras(texto(VARIANTES), [], [], contato(7));
    expect(a).toEqual(b);
    // o índice gravado aponta para o texto que saiu (0 = body)
    expect([BODY, ...VARIANTES][a.variante!]).toBe(a.fixed_body);
  });

  it("contatos diferentes se espalham pelas 3 redações", () => {
    const contagem = [0, 0, 0];
    for (let i = 0; i < 300; i++) contagem[turnPayloadExtras(texto(VARIANTES), [], [], contato(i)).variante!]!++;
    // cada redação recebe uma fatia razoável (esperado ~100 cada)
    for (const n of contagem) expect(n).toBeGreaterThan(60);
  });

  it("a chave inclui o nó: o mesmo contato não fica preso ao mesmo índice em todo passo", () => {
    const indices = new Set<number>();
    for (let n = 0; n < 20; n++) indices.add(turnPayloadExtras(texto(VARIANTES, `no-${n}`), [], [], contato(3)).variante!);
    expect(indices.size).toBeGreaterThan(1);
  });

  it("{{volta}} continua interpolado na variante escolhida", () => {
    const comVolta = texto(["volta {{volta}} B", "volta {{volta}} C"]);
    (comVolta.config as { body: string }).body = "volta {{volta}} A";
    const ev = [{ payload: { repeat_index: 2, repeat_total: 3 } }] as never;
    const out = turnPayloadExtras(comVolta, [], ev, contato(9));
    expect(out.fixed_body).toBe(`volta 2 ${"ABC"[out.variante!]}`);
  });
});

describe("publish: variantes passam pela régua do body", () => {
  const grafo = (variants: string[]): FlowGraph =>
    ({
      version: 2,
      nodes: [
        { id: "t", type: "trigger", label: "t", position: { x: 0, y: 0 }, config: {} },
        { ...texto(), config: { mode: "text", body: BODY, variants } },
      ],
      edges: [{ id: "e1", source: "t", target: "a1", condition: { type: "always" } }],
    }) as unknown as FlowGraph;

  const codigos = (g: FlowGraph) => {
    const r = validateFlowForPublish(g);
    return r.ok ? [] : r.errors.filter((e) => e.node_id === "a1").map((e) => e.code);
  };

  it("variante só de espaços reprova a publicação", () => {
    expect(codigos(grafo(["ok", "  "]))).toContain("invalid_text_variant");
  });
  it("variante acima do teto reprova", () => {
    expect(codigos(grafo(["ok", "x".repeat(4001)]))).toContain("invalid_text_variant");
  });
  it("variantes válidas não geram o erro", () => {
    expect(codigos(grafo(["ok", "também ok"]))).not.toContain("invalid_text_variant");
  });
});
