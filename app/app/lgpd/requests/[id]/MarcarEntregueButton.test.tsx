/**
 * "Marcar como entregue": só aparece no pedido de dados em revisão pendente, pede
 * confirmação e manda a forma da entrega.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/hooks/useLgpdPedidoManual", () => ({
  useMarcarPedidoEntregue: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MarcarEntregueButton } from "./MarcarEntregueButton";

beforeEach(() => h.mutate.mockReset());

describe("MarcarEntregueButton", () => {
  it.each([
    ["data_request", "received"],
    ["data_request", "processing"],
    ["data_request", "completed"],
    ["redact", "pending_review"],
  ] as const)("não aparece para %s em %s", (requestType, status) => {
    const { container } = render(<MarcarEntregueButton requestId="p1" requestType={requestType} status={status} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("clicar não grava nada: abre a confirmação; confirmar manda a forma e a observação", () => {
    render(<MarcarEntregueButton requestId="p1" requestType="data_request" status="pending_review" />);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como entregue" }));
    expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/quem entregou, quando e como/);

    fireEvent.change(screen.getByLabelText("Como foi entregue"), { target: { value: "whatsapp" } });
    fireEvent.change(screen.getByLabelText(/Observação/), { target: { value: "Enviado ao número do cadastro." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar entrega" }));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]![0]).toEqual({ method: "whatsapp", note: "Enviado ao número do cadastro." });
  });

  it("cancelar fecha sem gravar", () => {
    render(<MarcarEntregueButton requestId="p1" requestType="data_request" status="pending_review" />);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como entregue" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
