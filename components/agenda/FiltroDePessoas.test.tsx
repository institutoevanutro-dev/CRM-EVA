/** Item 134 da auditoria de 17/11: até 5 pessoas, sem sobreposição e com o nome à vista. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltroDePessoas } from "./FiltroDePessoas";
import type { Pessoa } from "./tipos";

afterEach(cleanup);

function pessoas(n: number): Pessoa[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nome: `Eva Alves ${i}`, trilha: 1 }) as Pessoa);
}

describe("filtro de pessoas da agenda", () => {
  it("com 5 pessoas: nome ao lado de cada avatar e nada sobreposto", () => {
    render(<FiltroDePessoas pessoas={pessoas(5)} selecionadas={[]} onMudar={vi.fn()} />);
    expect(screen.getByText("Eva Alves 0")).toBeTruthy();
    expect(screen.getByTestId("filtro-de-pessoas").innerHTML).not.toContain("-space-x-2");
  });

  it("com 6 ou mais: volta a empilhar, sem nomes", () => {
    render(<FiltroDePessoas pessoas={pessoas(6)} selecionadas={[]} onMudar={vi.fn()} />);
    expect(screen.queryByText("Eva Alves 0")).toBeNull();
    expect(screen.getByTestId("filtro-de-pessoas").innerHTML).toContain("-space-x-2");
  });
});
