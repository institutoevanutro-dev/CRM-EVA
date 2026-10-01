import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PalavrasDaIa } from "@/components/inbox/comentarios/PalavrasDaIa";

const decidirMock = vi.fn();
let dados: { candidatos: Array<{ palavra: string; vezes: number }>; decididas: Array<{ palavra: string; aprovada: boolean }> } | undefined;

vi.mock("@/hooks/comentarios/useComentarios", () => ({
  usePalavrasDaIa: () => ({ data: dados, isLoading: false }),
  useDecidirPalavra: () => ({ mutate: decidirMock, isPending: false }),
}));

beforeEach(() => {
  decidirMock.mockClear();
  dados = { candidatos: [{ palavra: "didatico", vezes: 4 }], decididas: [] };
});

describe("Palavras da IA", () => {
  it("mostra a palavra e em quantos comentários ela apareceu", () => {
    render(<PalavrasDaIa />);
    expect(screen.getByText("didatico")).toBeTruthy();
    expect(screen.getByText(/4/)).toBeTruthy();
  });

  it("NÃO mostra o comentário de origem: o dono escolheu julgar a palavra sozinha", () => {
    dados = { candidatos: [{ palavra: "didatico", vezes: 1 }], decididas: [] };
    const { container } = render(<PalavrasDaIa />);
    expect(container.textContent).not.toMatch(/coment[áa]rio de origem|exemplo/i);
  });

  it("Pode usar manda aprovada true; Nunca manda false", async () => {
    render(<PalavrasDaIa />);

    fireEvent.click(screen.getByRole("button", { name: /Pode usar/i }));
    await waitFor(() => expect(decidirMock).toHaveBeenCalledWith({ palavra: "didatico", aprovada: true }));

    decidirMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Nunca/i }));
    await waitFor(() => expect(decidirMock).toHaveBeenCalledWith({ palavra: "didatico", aprovada: false }));
  });

  it("sem candidatos, explica por que a lista está vazia", () => {
    dados = { candidatos: [], decididas: [] };
    render(<PalavrasDaIa />);
    expect(screen.getByText(/conforme você responde/i)).toBeTruthy();
  });

  it("dá para voltar atrás numa decisão já tomada", async () => {
    dados = { candidatos: [], decididas: [{ palavra: "didatico", aprovada: true }] };
    render(<PalavrasDaIa />);

    fireEvent.click(screen.getByText(/1 liberadas/i));
    fireEvent.click(screen.getByRole("button", { name: /Nunca/i }));

    await waitFor(() =>
      expect(decidirMock).toHaveBeenCalledWith({ palavra: "didatico", aprovada: false }),
    );
  });

  it("mostra quantas já foram liberadas e quantas recusadas", () => {
    dados = {
      candidatos: [],
      decididas: [
        { palavra: "a", aprovada: true },
        { palavra: "b", aprovada: true },
        { palavra: "c", aprovada: false },
      ],
    };
    render(<PalavrasDaIa />);
    expect(screen.getByText(/2 liberadas/i)).toBeTruthy();
    expect(screen.getByText(/1 recusada/i)).toBeTruthy();
  });
});
