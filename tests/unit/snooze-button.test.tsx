import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (...args: unknown[]) => postMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiErrorMock(...args),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));

import { SnoozeButton, horaDoLembrete } from "@/components/inbox/SnoozeButton";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

// Radix DropdownMenuTrigger abre no `pointerdown` (não `click`).
function openTrigger(btn: HTMLElement) {
  fireEvent.pointerDown(btn, { button: 0, ctrlKey: false, pointerId: 1 });
}

beforeEach(() => {
  postMock.mockReset();
  deleteMock.mockReset();
  showApiErrorMock.mockReset();
});

describe("SnoozeButton", () => {
  it("sem lembrete ativo: abre o dropdown e 'Em 3 horas' chama a mutation com duration_hours:3", async () => {
    postMock.mockResolvedValue({ data: { snooze_until: "2026-07-22T12:00:00.000Z" } });

    render(wrap(<SnoozeButton conversationId="conv-1" snoozeUntil={null} />));

    openTrigger(screen.getByRole("button", { name: /lembrar/i }));
    fireEvent.click(await screen.findByText(/^Em 3 horas · \d{2}:\d{2}$/));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/conv-1/snooze", {
        duration_hours: 3,
      }),
    );
    // Item 213: confirma, e diz a hora.
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        `Vou lembrar às ${horaDoLembrete("2026-07-22T12:00:00.000Z", "pt-BR")}`,
      ),
    );
  });

  it("com lembrete ativo (futuro): mostra a hora e 'Cancelar lembrete' chama o DELETE", async () => {
    deleteMock.mockResolvedValue(undefined);
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();

    render(wrap(<SnoozeButton conversationId="conv-1" snoozeUntil={futureIso} />));

    // Item 213: diz até quando.
    const rotulo = `Lembrete às ${horaDoLembrete(futureIso, "pt-BR")}`;
    expect(screen.getByRole("button", { name: rotulo })).toBeInTheDocument();
    openTrigger(screen.getByRole("button", { name: rotulo }));
    fireEvent.click(await screen.findByText("Cancelar lembrete"));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith("/api/v1/conversations/conv-1/snooze"),
    );
  });

  it("disabled prop desabilita o botão", () => {
    render(wrap(<SnoozeButton conversationId="conv-1" snoozeUntil={null} disabled />));
    expect(screen.getByRole("button", { name: /lembrar/i })).toBeDisabled();
  });

  it("erro na mutation chama showApiError", async () => {
    postMock.mockRejectedValue(new Error("falhou"));

    render(wrap(<SnoozeButton conversationId="conv-1" snoozeUntil={null} />));
    openTrigger(screen.getByRole("button", { name: /lembrar/i }));
    fireEvent.click(await screen.findByText(/^Em 1 hora · /));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
  });
});
