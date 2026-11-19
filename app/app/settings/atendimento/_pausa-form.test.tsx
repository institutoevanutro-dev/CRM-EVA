import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const patch = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PausaDaIaForm } from "./_pausa-form";

it("o interruptor salva no toque, sozinho, e o texto espera o Salvar com aviso", async () => {
  render(<PausaDaIaForm initial={5} initialEspera={null} initialMaxHoras={4} initialFimDoDiaSeguinte={false} />);

  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("/api/v1/settings/atendimento/pausa-da-ia", { fim_do_dia_seguinte: true }),
  );
  expect(screen.queryByText("Há mudanças não salvas")).toBeNull();

  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText(/Quanto tempo a IA fica fora/), { target: { value: "120" } });
  expect(screen.getByText("Há mudanças não salvas")).toBeTruthy();
  expect(patch).toHaveBeenCalledTimes(2);
});
