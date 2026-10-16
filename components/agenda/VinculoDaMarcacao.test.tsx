/**
 * Criar contato SEM sair da marcação.
 *
 * O que esta suíte protege: quem marca horário costuma estar com a pessoa na
 * frente, e ela nem sempre já é contato. Antes deste atalho o fluxo PARAVA aqui
 * — era preciso abandonar a marcação, ir até Contatos, criar, voltar e
 * recomeçar. O termo digitado vira o nome, e o contato volta **selecionado**.
 *
 * O caso 3 é o que mais importa e o mais fácil de quebrar numa refatoração: se
 * `onCriado` deixar de propagar o id, o contato nasce e a marcação continua sem
 * ninguém — sem erro nenhum na tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VinculoDaMarcacao } from "./VinculoDaMarcacao";

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

// O diálogo real arrasta formulário, toasts e mutation. Aqui interessa o FIO:
// ele recebe o nome digitado e devolve o contato criado?
vi.mock("@/components/contacts/NewContactDialog", () => ({
  NewContactDialog: ({
    open,
    nomeInicial,
    onCriado,
  }: {
    open: boolean;
    nomeInicial?: string;
    onCriado?: (c: { id: string; name: string }) => void;
  }) =>
    open ? (
      <div>
        <span data-testid="nome-recebido">{nomeInicial}</span>
        <button type="button" onClick={() => onCriado?.({ id: "c-99", name: "Joana Prado" })}>
          simular criação
        </button>
      </div>
    ) : null,
}));

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function responderCom(
  contacts: Array<{ id: string; name: string | null; display_name?: string | null; phone_number?: string | null }>,
) {
  get.mockResolvedValue({ data: { contacts, conversations: [] } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VinculoDaMarcacao", () => {
  it("oferece criar quando a busca não encontra ninguém", async () => {
    responderCom([]);
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Buscar cliente/i), "Joana");

    await waitFor(() => expect(screen.getByRole("button", { name: /Criar/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Joana/ })).toBeInTheDocument();
  });

  it("NÃO oferece criar quando a busca encontra alguém", async () => {
    responderCom([{ id: "c-1", name: "Joana Prado" }]);
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Buscar cliente/i), "Joana");

    await waitFor(() => expect(screen.getByRole("option", { name: "Joana Prado" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Criar/i })).not.toBeInTheDocument();
  });

  it("leva o nome digitado e devolve o contato JÁ SELECIONADO", async () => {
    responderCom([]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={onChange} />);

    await user.type(screen.getByLabelText(/Buscar cliente/i), "Joana");
    await waitFor(() => expect(screen.getByRole("button", { name: /Criar/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Criar/i }));

    // o que foi digitado chega ao diálogo, para não redigitar
    expect(screen.getByTestId("nome-recebido")).toHaveTextContent("Joana");

    await user.click(screen.getByRole("button", { name: /simular criação/i }));

    // e o contato volta selecionado — é isto que evita procurar o que acabou de criar
    expect(onChange).toHaveBeenCalledWith("c-99", "");
  });

  it("não oferece criar antes de digitar", async () => {
    responderCom([]);
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Criar/i })).not.toBeInTheDocument();
  });

  // ─── A busca tem de MOSTRAR quem achou (produção, 4.12.0) ──────────────────
  // O dono da clínica digitou "Marcelo", a busca achou 11 pessoas, e nada mudou
  // na tela: os nomes iam para DENTRO de um `select` fechado que continuava
  // dizendo "Compromisso pessoal, sem cliente". Ele concluiu que não dava para
  // marcar paciente. Estes casos medem o que se vê, não o que existe no DOM.

  function ComEstado() {
    const [v, setV] = useState({ contact: "", conversation: "" });
    return (
      <VinculoDaMarcacao
        contactId={v.contact}
        conversationId={v.conversation}
        onChange={(contact, conversation) => setV({ contact, conversation })}
      />
    );
  }

  const SOUZA = { id: "c-1", name: "Marcelo Souza", display_name: null, phone_number: "+5511987654321" };
  const LIMA = { id: "c-2", name: "Marcelo Lima", display_name: null, phone_number: "+5511912345678" };
  const MARCELOS = [SOUZA, LIMA];

  it("mostra a lista de quem a busca achou, logo abaixo do campo, com o telefone", async () => {
    responderCom(MARCELOS);
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    const campo = screen.getByRole("combobox", { name: /Buscar cliente/i });
    await user.type(campo, "Marcelo");

    const lista = await screen.findByRole("listbox");
    expect(campo).toHaveAttribute("aria-expanded", "true");
    expect(campo).toHaveAttribute("aria-controls", lista.id);
    const opcoes = screen.getAllByRole("option");
    expect(opcoes).toHaveLength(2);
    expect(opcoes[0]).toHaveTextContent("Marcelo Souza");
    expect(opcoes[0]).toHaveTextContent("+5511987654321");
  });

  it("clicar no paciente seleciona e mostra quem foi escolhido, com Trocar", async () => {
    responderCom(MARCELOS);
    const user = userEvent.setup();
    envolver(<ComEstado />);

    await user.type(screen.getByRole("combobox", { name: /Buscar cliente/i }), "Marcelo");
    await user.click(await screen.findByRole("option", { name: /Marcelo Lima/ }));

    const escolhido = await screen.findByTestId("paciente-escolhido");
    expect(escolhido).toHaveAttribute("data-contact-id", "c-2");
    expect(escolhido).toHaveTextContent("Marcelo Lima");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Trocar/i }));
    expect(screen.queryByTestId("paciente-escolhido")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Buscar cliente/i })).toHaveFocus();
  });

  it("setas e Enter escolhem pelo teclado; Escape fecha a lista", async () => {
    responderCom(MARCELOS);
    const onChange = vi.fn();
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={onChange} />);

    const campo = screen.getByRole("combobox", { name: /Buscar cliente/i });
    await user.type(campo, "Marcelo");
    await screen.findByRole("listbox");

    await user.keyboard("{ArrowDown}");
    expect(campo).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1]?.id ?? "");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("c-2", "");

    await user.type(campo, "x");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(campo).toHaveAttribute("aria-expanded", "false");
  });

  it("quando só um paciente bate, ele já vem escolhido, e continua trocável", async () => {
    responderCom([SOUZA]);
    const user = userEvent.setup();
    envolver(<ComEstado />);

    await user.type(screen.getByRole("combobox", { name: /Buscar cliente/i }), "Marcelo");

    const escolhido = await screen.findByTestId("paciente-escolhido");
    expect(escolhido).toHaveAttribute("data-contact-id", "c-1");
    expect(screen.getByRole("button", { name: /Trocar/i })).toBeInTheDocument();
    // continua VISÍVEL na lista, marcado, para conferir antes de salvar
    expect(await screen.findByRole("option", { name: /Marcelo Souza/ })).toHaveAttribute("aria-selected", "true");
  });

  it("diz 'Nenhum paciente encontrado' quando a busca volta vazia", async () => {
    responderCom([]);
    const user = userEvent.setup();
    envolver(<VinculoDaMarcacao contactId="" conversationId="" onChange={vi.fn()} />);

    await user.type(screen.getByRole("combobox", { name: /Buscar cliente/i }), "Zuleica");
    expect(await screen.findByText("Nenhum paciente encontrado")).toBeInTheDocument();
  });

  it("sem paciente, deixa claro que é compromisso pessoal; com paciente, oferece voltar a isso", async () => {
    responderCom([SOUZA]);
    const user = userEvent.setup();
    envolver(<ComEstado />);

    expect(screen.getByText(/Compromisso pessoal, sem cliente/)).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: /Buscar cliente/i }), "Marcelo");
    await screen.findByTestId("paciente-escolhido");

    await user.click(screen.getByRole("button", { name: /Compromisso pessoal, sem cliente/i }));
    expect(screen.queryByTestId("paciente-escolhido")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Buscar cliente/i })).toHaveValue("");
  });
});
