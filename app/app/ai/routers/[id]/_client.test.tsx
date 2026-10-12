/**
 * Painel "Testar classificação" do roteador: testa com o roteador inativo e,
 * opcionalmente, como um contato (o classificador recebe a agenda dele).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { useTestRouter, type RouterTestResult } from "@/hooks/ai/useRouters";
import { TestPanel } from "./_client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/ai/useRouters", () => ({
  useRouter: vi.fn(),
  useUpdateRouter: vi.fn(),
  useDeleteRouter: vi.fn(),
  useSaveMembers: vi.fn(),
  useTestRouter: vi.fn(),
}));
// O seletor real busca contatos na API; aqui basta a porta que ele expõe.
vi.mock("@/components/kanban/SeletorDeContato", () => ({
  SeletorDeContato: ({
    escolhido,
    onEscolher,
  }: {
    escolhido: { id: string } | null;
    onEscolher: (c: { id: string } | null) => void;
  }) => (
    <button type="button" onClick={() => onEscolher(escolhido ? null : { id: "contato-1" })}>
      {escolhido ? "trocar contato" : "escolher contato"}
    </button>
  ),
}));

const mutate = vi.fn();

function comResultado(data: RouterTestResult | undefined) {
  vi.mocked(useTestRouter).mockReturnValue({ mutate, data, isPending: false } as never);
}

const RESULTADO: RouterTestResult = {
  intent_name: "vendas",
  confidence: 0.9,
  min_confidence: 0.6,
  agent_id: "a1",
  agent_name: "Agente Vendas",
  fatos: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  comResultado(undefined);
});

describe("TestPanel do roteador", () => {
  it("não pede para ativar o roteador: o teste funciona com ele inativo", () => {
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.queryByText(/Ative o roteador/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByText("Testar como um contato (opcional)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Com um contato, o roteador também considera a agenda dele: atendimentos anteriores e compromissos futuros.",
      ),
    ).toBeInTheDocument();
  });

  it("sem contato, manda só a mensagem", () => {
    render(<TestPanel routerId="r1" canTest />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "quanto custa?" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar classificação/ }));
    expect(mutate).toHaveBeenCalledWith({ message: "quanto custa?", contactId: null }, expect.anything());
  });

  it("o contato escolhido vai junto com a mensagem", () => {
    render(<TestPanel routerId="r1" canTest />);
    fireEvent.click(screen.getByRole("button", { name: "escolher contato" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "quero remarcar" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar classificação/ }));
    expect(mutate).toHaveBeenCalledWith({ message: "quero remarcar", contactId: "contato-1" }, expect.anything());
  });

  it("mostra o que o roteador viu sobre o contato quando há fatos", () => {
    comResultado({ ...RESULTADO, fatos: "Atendimentos anteriores:\n- 02/09/2026: Primeira consulta" });
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.getByText("O que o roteador viu sobre o contato")).toBeInTheDocument();
    expect(screen.getByText(/02\/09\/2026: Primeira consulta/)).toBeInTheDocument();
  });

  it("sem fatos, o bloco do contato não aparece", () => {
    comResultado(RESULTADO);
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.getByText("Agente Vendas")).toBeInTheDocument();
    expect(screen.queryByText("O que o roteador viu sobre o contato")).not.toBeInTheDocument();
  });
});
