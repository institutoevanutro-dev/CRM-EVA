import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PalavrasDaIa } from "@/components/inbox/comentarios/PalavrasDaIa";

const decidirMock = vi.fn();
let dados: { candidatos: Array<{ palavra: string; vezes: number }>; decididas: Array<{ palavra: string; aprovada: boolean }> } | undefined;
let falhou = false;
let carregando = false;

vi.mock("@/hooks/comentarios/useComentarios", () => ({
  usePalavrasDaIa: () => ({ data: dados, isLoading: carregando, isError: falhou }),
  useDecidirPalavra: () => ({ mutate: decidirMock, isPending: false }),
}));

beforeEach(() => {
  decidirMock.mockClear();
  falhou = false;
  carregando = false;
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

  it("não promete o histórico inteiro: a consulta olha só os comentários recentes", () => {
    const { container } = render(<PalavrasDaIa />);
    expect(container.textContent).not.toMatch(/hist[óo]rico/i);
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

    fireEvent.click(screen.getByText(/1 palavra liberada/i));
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
    expect(screen.getByText(/2 palavras liberadas/i)).toBeTruthy();
    expect(screen.getByText(/1 recusada\b(?!s)/i)).toBeTruthy();
  });

  it("concorda em número: 1 liberada, 2 recusadas", () => {
    dados = {
      candidatos: [],
      decididas: [
        { palavra: "a", aprovada: true },
        { palavra: "b", aprovada: false },
        { palavra: "c", aprovada: false },
      ],
    };
    render(<PalavrasDaIa />);
    expect(screen.getByText(/1 palavra liberada/i)).toBeTruthy();
    expect(screen.getByText(/2 recusadas/i)).toBeTruthy();
  });

  // I-5 (revisão final): `isLoading || !data` deixava "Carregando…" eterno em
  // erro de rede, 500 ou 403 — a tela mentia para sempre.
  it("erro de leitura diz que falhou, e NÃO fica carregando para sempre", () => {
    falhou = true;
    dados = undefined;
    const { container } = render(<PalavrasDaIa />);
    expect(container.textContent).not.toMatch(/Carregando/i);
    expect(container.textContent).toMatch(/Não foi possível carregar as palavras/i);
  });

  it("carregando de verdade continua dizendo carregando", () => {
    carregando = true;
    dados = undefined;
    const { container } = render(<PalavrasDaIa />);
    expect(container.textContent).toMatch(/Carregando/i);
  });

  // I-6: dois botões idênticos por linha sem rótulo são indistinguíveis para
  // leitor de tela.
  it("os botões dizem SOBRE QUAL PALAVRA são, na lista e no rodapé", () => {
    dados = {
      candidatos: [{ palavra: "didatico", vezes: 4 }],
      decididas: [{ palavra: "fantastico", aprovada: true }],
    };
    render(<PalavrasDaIa />);
    expect(screen.getByRole("button", { name: "Pode usar didatico" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nunca didatico" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nunca fantastico" })).toBeTruthy();
  });

  // MENOR: faltava o substantivo — a linha saía "didatico em 4 que você respondeu".
  it("a contagem nomeia o que está contando", () => {
    const { container } = render(<PalavrasDaIa />);
    expect(container.textContent).toMatch(/em 4 comentários que você respondeu/);
  });
});
