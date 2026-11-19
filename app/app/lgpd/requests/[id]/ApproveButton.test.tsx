/**
 * Aprovar o pedido: diz de quem é, e apagar dados pede a mesma guarda da ficha
 * (justificativa + digitar ANONIMIZAR). A cópia dos dados só pede justificativa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/hooks/useApproveLgpdRequest", () => ({
  useApproveLgpdRequest: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ useApiErrorHandler: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApproveButton } from "./ApproveButton";

beforeEach(() => h.mutate.mockReset());

const JUSTIFICATIVA = "Pedido formal da paciente pelo WhatsApp.";

describe("ApproveButton", () => {
  it("apagar dados: nome no título, e só confirma depois de digitar ANONIMIZAR", () => {
    render(<ApproveButton requestId="p1" requestType="redact" status="received" titular="Maria Exemplo" />);
    fireEvent.click(screen.getByRole("button", { name: /Apagar dados do paciente/ }));
    expect(screen.getByText(/Apagar os dados de Maria Exemplo/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Justificativa/), { target: { value: JUSTIFICATIVA } });
    const confirmar = screen.getByRole("button", { name: "Apagar permanentemente" });
    expect(confirmar).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirmação"), { target: { value: "anonimizar" } });
    expect(confirmar).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirmação"), { target: { value: "ANONIMIZAR" } });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    expect(h.mutate).toHaveBeenCalledWith({ id: "p1", approved_reason: JUSTIFICATIVA }, expect.anything());
  });

  it("cópia dos dados não pede a palavra", () => {
    render(<ApproveButton requestId="p1" requestType="data_request" status="received" titular="Maria Exemplo" />);
    fireEvent.click(screen.getByRole("button", { name: /Aprovar a cópia dos dados/ }));
    expect(screen.queryByLabelText("Confirmação")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Justificativa/), { target: { value: JUSTIFICATIVA } });
    expect(screen.getByRole("button", { name: "Confirmar aprovação" })).toBeEnabled();
  });

  it("não aparece fora de 'received'", () => {
    const { container } = render(
      <ApproveButton requestId="p1" requestType="redact" status="processing" titular="Maria Exemplo" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
