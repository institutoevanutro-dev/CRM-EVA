/** A fileira de profissionais (decisão 3 do André, 27/11/2026). Nomes fictícios. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pessoasComAtendimento } from "@/lib/agenda/pessoas-da-grade";

import { FiltroDePessoas } from "./FiltroDePessoas";
import type { Agendamento, Pessoa } from "./tipos";

afterEach(cleanup);

const ANA: Pessoa = { id: "ana", nome: "Ana Prado", trilha: 1 };
const BIA: Pessoa = { id: "bia", nome: "Bia Souza", trilha: 2 };
const CAIO: Pessoa = { id: "caio", nome: "Caio Lima", trilha: 3 };

function de(responsavelId: string, extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id: `c-${responsavelId}`,
    titulo: "Consulta",
    responsavelId,
    comeca: "2026-09-16T10:00:00-03:00",
    termina: "2026-09-16T10:30:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...extra,
  };
}

describe("quem entra na fileira", () => {
  it("só quem é dono de compromisso nosso no período, na ordem da equipe", () => {
    expect(pessoasComAtendimento([ANA, BIA, CAIO], [de("caio"), de("ana")], []).map((p) => p.id)).toEqual(["ana", "caio"]);
  });

  it("ocupação do Google e cancelado não põem ninguém na fileira", () => {
    const fora = [de("bia", { origem: "google_sync" }), de("caio", { situacao: "cancelled" })];
    expect(pessoasComAtendimento([ANA, BIA, CAIO], fora, [])).toEqual([]);
  });

  it("a escolhida continua na fileira numa semana em que não tem nada", () => {
    expect(pessoasComAtendimento([ANA, BIA], [de("ana")], ["bia"]).map((p) => p.id)).toEqual(["ana", "bia"]);
  });
});

describe("fileira de profissionais", () => {
  it("'Todos' vem primeiro e começa marcado; cada pessoa com ponto de cor e nome curto", () => {
    render(<FiltroDePessoas pessoas={[ANA, BIA]} selecionadas={[]} onMudar={vi.fn()} />);
    const botoes = within(screen.getByTestId("filtro-de-pessoas")).getAllByRole("button");
    expect(botoes[0]).toHaveTextContent("Todos");
    expect(botoes[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveTextContent("Ana P.");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveAttribute("title", "Ana Prado");
    // WCAG 2.5.3: o nome acessível é o que está À VISTA ("Ana P."), para quem
    // fala com o leitor de voz o que lê na tela; o nome inteiro vem do `title`.
    expect(screen.getByRole("button", { name: "Ana P." })).toBe(screen.getByTestId("botao-pessoa-ana"));
    expect(screen.getByTestId("botao-pessoa-ana")).not.toHaveAttribute("aria-label");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveAccessibleDescription("Ana Prado");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicar escolhe UMA pessoa; clicar de novo, ou em Todos, volta a todos", () => {
    const onMudar = vi.fn();
    const { rerender } = render(<FiltroDePessoas pessoas={[ANA, BIA]} selecionadas={[]} onMudar={onMudar} />);
    fireEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(onMudar).toHaveBeenLastCalledWith(["ana"]);

    rerender(<FiltroDePessoas pessoas={[ANA, BIA]} selecionadas={["ana"]} onMudar={onMudar} />);
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "ana");
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("botao-pessoa-bia"));
    expect(onMudar).toHaveBeenLastCalledWith(["bia"]);
    fireEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(onMudar).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByTestId("botao-todos"));
    expect(onMudar).toHaveBeenLastCalledWith([]);
  });

  it("ninguém com atendimento e ninguém escolhido: a fileira some", () => {
    render(<FiltroDePessoas pessoas={[]} selecionadas={[]} onMudar={vi.fn()} />);
    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
  });
});
