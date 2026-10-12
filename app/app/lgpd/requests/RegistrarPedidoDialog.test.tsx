/**
 * O formulário "Registrar pedido": o que ele manda, o que ele trava e como
 * mostra a recusa por duplicata (com a ligação para o pedido que já existe).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ApiError } from "@/lib/api/types";
import type * as PedidoManual from "@/lib/lgpd/pedido-manual";
import type { Contact } from "@/lib/types/contacts";

const h = vi.hoisted(() => ({ mutate: vi.fn(), pendente: false }));
vi.mock("@/hooks/useLgpdPedidoManual", () => ({
  useRegistrarPedidoLgpd: () => ({ mutate: h.mutate, isPending: h.pendente }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/lgpd/pedido-manual", async (original) => ({
  ...(await original<typeof PedidoManual>()),
  hojeNoBrasil: () => "2026-10-12",
}));
const MICHELLE = {
  id: "22222222-2222-4222-8222-222222222222",
  display_name: "Michelle",
  name: "Michelle",
  email: "michelle@exemplo.com",
  phone_number: "5511988887777",
  is_anonymized: false,
  tags: [],
} as unknown as Contact;
// O seletor de verdade tem teste próprio; aqui basta um botão que escolhe.
vi.mock("@/components/kanban/SeletorDeContato", () => ({
  SeletorDeContato: ({ escolhido, onEscolher }: { escolhido: Contact | null; onEscolher: (c: Contact) => void }) => (
    <button type="button" onClick={() => onEscolher(MICHELLE)}>
      {escolhido ? "contato escolhido" : "escolher contato"}
    </button>
  ),
}));

import { RegistrarPedidoDialog } from "./RegistrarPedidoDialog";

function abrir() {
  render(<RegistrarPedidoDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Registrar pedido" }));
}
const enviar = () => screen.getAllByRole("button", { name: "Registrar pedido" }).at(-1)!;

beforeEach(() => {
  h.mutate.mockReset();
  h.pendente = false;
});

describe("RegistrarPedidoDialog", () => {
  it("fechado, só mostra o botão", () => {
    render(<RegistrarPedidoDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sem contato não envia; a data nasce em hoje e não aceita futuro", () => {
    abrir();
    expect(enviar()).toBeDisabled();
    const data = screen.getByLabelText("Dia em que a pessoa pediu") as HTMLInputElement;
    expect(data.value).toBe("2026-10-12");
    expect(data.max).toBe("2026-10-12");

    fireEvent.click(screen.getByRole("button", { name: "escolher contato" }));
    expect(enviar()).toBeEnabled();
    fireEvent.change(data, { target: { value: "2026-10-13" } });
    expect(enviar()).toBeDisabled();
    expect(screen.getByText("A data em que o pedido chegou não pode estar no futuro.")).toBeInTheDocument();
  });

  it("escolher o contato preenche o e-mail dele, e o envio leva tudo o que foi digitado", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "escolher contato" }));
    expect((screen.getByLabelText(/E-mail para enviar o relatório/) as HTMLInputElement).value).toBe("michelle@exemplo.com");

    fireEvent.change(screen.getByLabelText("Como o pedido chegou"), { target: { value: "presencial" } });
    fireEvent.change(screen.getByLabelText("Dia em que a pessoa pediu"), { target: { value: "2026-10-09" } });
    fireEvent.change(screen.getByLabelText(/Observação/), { target: { value: " Pediu no balcão. " } });
    fireEvent.click(enviar());

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]![0]).toEqual({
      contact_id: MICHELLE.id,
      request_type: "data_request",
      channel: "presencial",
      received_on: "2026-10-09",
      delivery_email: "michelle@exemplo.com",
      note: "Pediu no balcão.",
    });
  });

  it("pedido de apagamento avisa que registrar não apaga nada, e não pede e-mail", () => {
    abrir();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("O que a pessoa pediu"), { target: { value: "redact" } });
    expect(screen.getByRole("note")).toHaveTextContent(/Registrar não apaga nada.*aprovar.*não pode ser desfeita/);
    expect(screen.queryByLabelText(/E-mail para enviar o relatório/)).not.toBeInTheDocument();
  });

  it("recusa por duplicata mostra a mensagem do servidor e liga para o pedido em aberto", () => {
    h.mutate.mockImplementation((_corpo, { onError }) =>
      onError(new ApiError(409, "state_conflict", { existing_request_id: "abc-123" }, "r1", "Este contato já tem um pedido igual em aberto.")),
    );
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "escolher contato" }));
    fireEvent.click(enviar());
    expect(screen.getByRole("alert")).toHaveTextContent("Este contato já tem um pedido igual em aberto.");
    expect(screen.getByRole("link", { name: "Abrir o pedido em aberto" })).toHaveAttribute(
      "href",
      "/app/lgpd/requests/abc-123",
    );
  });

  it("enquanto envia, o botão fica travado", () => {
    h.pendente = true;
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "escolher contato" }));
    expect(screen.getByRole("button", { name: "Registrando…" })).toBeDisabled();
  });
});
