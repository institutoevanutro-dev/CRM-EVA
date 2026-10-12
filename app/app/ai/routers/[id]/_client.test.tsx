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
  SeletorDeContato: (props: {
    escolhido: { id: string } | null;
    onEscolher: (c: { id: string } | null) => void;
    rotulo?: string;
    semCriar?: boolean;
    soComBusca?: boolean;
  }) => {
    propsDoSeletor(props);
    return (
      <button type="button" onClick={() => props.onEscolher(props.escolhido ? null : { id: "contato-1" })}>
        {props.escolhido ? "limpar contato" : "escolher contato"}
      </button>
    );
  },
}));

const propsDoSeletor = vi.fn();
const mutate = vi.fn();
const reset = vi.fn();

function comResultado(data: RouterTestResult | undefined) {
  vi.mocked(useTestRouter).mockReturnValue({ mutate, reset, data, isPending: false } as never);
}

const RESULTADO: RouterTestResult = {
  intent_name: "vendas",
  confidence: 0.9,
  min_confidence: 0.6,
  agent_id: "a1",
  agent_name: "Agente Vendas",
  fatos: null,
  mode: "roteador",
  kept_current: false,
  classified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  comResultado(undefined);
});

describe("TestPanel do roteador", () => {
  it("não pede para ativar o roteador: o teste funciona com ele inativo", () => {
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.queryByText(/Ative o roteador/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Mensagem de teste" })).toBeEnabled();
    // Um rótulo só, entregue ao seletor; sem criar contato e sem lista aberta.
    expect(screen.queryByText("Testar como um contato (opcional)")).not.toBeInTheDocument();
    expect(propsDoSeletor).toHaveBeenLastCalledWith(
      expect.objectContaining({ rotulo: "Testar como um contato (opcional)", semCriar: true, soComBusca: true }),
    );
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

  it("escolher e limpar o contato apagam o resultado anterior", () => {
    comResultado({ ...RESULTADO, fatos: "Fatos do CRM sobre este contato (agenda):\n- Compromissos passados (não cancelados): 02/09/2026 Primeira consulta (realizado)\n- Compromissos futuros: nenhum" });
    render(<TestPanel routerId="r1" canTest />);
    fireEvent.click(screen.getByRole("button", { name: "escolher contato" }));
    expect(reset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "limpar contato" }));
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("o resultado é anunciado a leitor de tela", () => {
    comResultado(RESULTADO);
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.getByText("Agente Vendas").closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  });

  it("mostra o que o roteador viu sobre o contato quando há fatos", () => {
    comResultado({ ...RESULTADO, fatos: "Fatos do CRM sobre este contato (agenda):\n- Compromissos passados (não cancelados): 02/09/2026 Primeira consulta (realizado)\n- Compromissos futuros: nenhum" });
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.getByText("O que o roteador viu sobre o contato")).toBeInTheDocument();
    expect(screen.getByText(/02\/09\/2026 Primeira consulta/)).toBeInTheDocument();
  });

  it("sem fatos, o bloco do contato não aparece", () => {
    comResultado(RESULTADO);
    render(<TestPanel routerId="r1" canTest />);
    expect(screen.getByText("Agente Vendas")).toBeInTheDocument();
    expect(screen.queryByText("O que o roteador viu sobre o contato")).not.toBeInTheDocument();
  });
});
