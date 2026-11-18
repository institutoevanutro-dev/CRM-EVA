/**
 * Item 34 da auditoria de 17/11 — mensagens agendadas:
 *  - agendar o texto do campo LIMPA o campo (o Enter seguinte mandava na hora a
 *    mesma mensagem que acabara de ser agendada);
 *  - cancelar um agendamento pergunta antes e trava o botão enquanto sai.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AMANHA = new Date(Date.now() + 86_400_000);
const pendente = {
  id: "ag-1",
  title: null,
  body: "Lembrete da consulta",
  scheduled_at: AMANHA.toISOString(),
  status: "agendada",
  se_desconectado: "esperar",
  motivo: null,
  mensagem: null,
};
const apagar = vi.fn(() => new Promise(() => {}));
const criar = vi.fn(async () => ({ data: {} }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: [pendente] })),
    post: (...a: unknown[]) => criar(...(a as [])),
    patch: vi.fn(),
    delete: () => apagar(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MensagensAgendadasBotao } from "@/components/inbox/MensagensAgendadas";

function montar(props: Partial<Parameters<typeof MensagensAgendadasBotao>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MensagensAgendadasBotao conversationId="conv-1" aberto onAbertoChange={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

const p2 = (n: number) => String(n).padStart(2, "0");

describe("mensagens agendadas", () => {
  beforeEach(() => {
    apagar.mockClear();
    criar.mockClear();
  });

  it("⭐ agendar o texto do campo pede para limpar o campo", async () => {
    const onAgendouOTexto = vi.fn();
    montar({ textoInicial: "Ana, sua consulta é amanhã", onAgendouOTexto });
    fireEvent.click(await screen.findByRole("button", { name: /Adicionar/ }));
    expect(screen.getByLabelText("Mensagem")).toHaveValue("Ana, sua consulta é amanhã");
    fireEvent.change(screen.getByLabelText("Data"), {
      target: { value: `${AMANHA.getFullYear()}-${p2(AMANHA.getMonth() + 1)}-${p2(AMANHA.getDate())}` },
    });
    fireEvent.change(screen.getByLabelText("Hora"), { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));
    await waitFor(() => expect(criar).toHaveBeenCalled());
    await waitFor(() => expect(onAgendouOTexto).toHaveBeenCalledTimes(1));
  });

  it("cancelar pergunta antes e trava o botão enquanto o pedido sai", async () => {
    montar();
    const lixeira = await screen.findByRole("button", { name: "Cancelar mensagem agendada" });
    fireEvent.click(lixeira);
    expect(apagar).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Cancelar esta mensagem agendada?");

    fireEvent.click(screen.getByRole("button", { name: "Cancelar envio" }));
    expect(apagar).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancelar mensagem agendada" })).toBeDisabled());
  });
});
