import { describe, expect, it, vi } from "vitest";
import { reconciliarNomes } from "./sincronizar-nomes";

describe("nomes do Financeiro", () => {
  it("preenche apenas o contato vinculado, sem exigir venda nem comparar telefone", async () => {
    const consultar = vi.fn(async (id: string) => ({
      resumo: id === "cristiano" ? { paciente_nome: "Cristiano Guaitolini" } : null,
    }));
    const gravar = vi.fn(async (_id: string, nome: string | null) => !!nome);
    const resultado = await reconciliarNomes(
      [{ id: "cristiano", name: null }, { id: "beatriz", name: null }],
      consultar,
      gravar,
    );
    expect(resultado).toEqual({ consultados: 2, atualizados: 1, falhas: 0 });
    expect(gravar).toHaveBeenCalledWith("cristiano", "Cristiano Guaitolini");
    expect(gravar).toHaveBeenCalledWith("beatriz", null);
  });

  it("preserva nome preenchido e contabiliza edição concorrente sem sobrescrever", async () => {
    const consultar = vi.fn(async () => ({ resumo: { paciente_nome: "Nome financeiro" } }));
    const gravar = vi.fn(async () => false); // UPDATE condicional afetou zero linhas
    expect(await reconciliarNomes(
      [{ id: "manual", name: "Nome manual" }, { id: "concorrente", name: null }],
      consultar,
      gravar,
    )).toEqual({ consultados: 1, atualizados: 0, falhas: 0 });
    expect(consultar).toHaveBeenCalledTimes(1);
  });

  it("avança a fila após falha remota para permitir nova tentativa", async () => {
    const gravar = vi.fn(async () => false);
    expect(await reconciliarNomes(
      [{ id: "primeiro", name: null }],
      async () => { throw new Error("indisponível"); },
      gravar,
    )).toEqual({ consultados: 1, atualizados: 0, falhas: 1 });
    expect(gravar).toHaveBeenCalledWith("primeiro", null);
  });
});
