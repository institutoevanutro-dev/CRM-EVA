// @vitest-environment node
/**
 * "AVISAR A EQUIPE" (`decidindo`) É SÓ DOS DOIS PEDIDOS DO CLIENTE. O clima
 * nunca decide: nem pela rota, nem gravado à mão no banco.
 */
import { describe, expect, it } from "vitest";

import { estadoEfetivo, estadosDasTarefasSchema, estadosPermitidos, lerConfigDoJev } from "./config";

const ligado = (tarefas: Record<string, unknown>) =>
  lerConfigDoJev({ jev: { ligado: true, aceite: { em: "2026-10-12T12:00:00.000Z", por: "u" }, tarefas } });

describe("o estado decidindo por tarefa", () => {
  it("a rota aceita decidindo nos dois pedidos e recusa no clima", () => {
    expect(estadosDasTarefasSchema.safeParse({ opt_out: "decidindo", humano: "decidindo" }).success).toBe(true);
    expect(estadosDasTarefasSchema.safeParse({ clima: "decidindo" }).success).toBe(false);
    expect(estadosDasTarefasSchema.safeParse({ clima: "avisar" }).success).toBe(false);
    expect(estadosDasTarefasSchema.safeParse({ clima: "observando" }).success).toBe(true);
    expect(estadosPermitidos("clima")).toEqual(["observando", "desligada"]);
    expect(estadosPermitidos("opt_out")).toContain("decidindo");
  });

  it("decidindo gravado à mão no clima é lido como desligada; nos pedidos, vale", () => {
    const config = ligado({ clima: { estado: "decidindo" }, humano: { estado: "decidindo" } });
    expect(estadoEfetivo(config, "clima")).toBe("desligada");
    expect(estadoEfetivo(config, "humano")).toBe("decidindo");
  });

  it("sem estado gravado, a tarefa segue observando: o deploy não liga aviso nenhum", () => {
    const config = ligado({});
    for (const id of ["clima", "humano", "opt_out"] as const) expect(estadoEfetivo(config, id)).toBe("observando");
  });

  it("sem aceite ou desligado, decidindo não vale", () => {
    const semAceite = lerConfigDoJev({ jev: { ligado: true, aceite: null, tarefas: { opt_out: { estado: "decidindo" } } } });
    expect(estadoEfetivo(semAceite, "opt_out")).toBe("desligada");
  });
});
