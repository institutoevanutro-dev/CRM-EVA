import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActionForm } from "./ActionForm";

const M1 = "44444444-4444-4444-8444-444444444444";
const M2 = "55555555-5555-4555-8555-555555555555";

vi.mock("@/hooks/ai/useMidias", () => ({
  useMidias: () => ({
    isLoading: false,
    isError: false,
    data: [
      { id: M1, title: "Antes e depois", situacao: "pronta" },
      { id: M2, title: "Foto da clínica", situacao: "sem_termo" },
    ],
  }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ isLoading: false, isError: false, data: [] }),
}));

// jsdom não tem o que o Radix Select pede para abrir.
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

describe("ActionForm — modo mídia", () => {
  it("escolher a mídia e a legenda chama onChange com o config media", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(<ActionForm config={{ mode: "media", media_id: M1 }} onChange={onChange} />);

    await user.type(screen.getByLabelText("Legenda (opcional)"), "Oi");

    expect(onChange).toHaveBeenLastCalledWith({ mode: "media", media_id: M1, caption: "Oi" });
  });

  it("item não pronto aparece marcado com a situação", async () => {
    const user = userEvent.setup({ delay: null });
    render(<ActionForm config={{ mode: "media", media_id: M1 }} onChange={() => {}} />);

    await user.click(screen.getByRole("combobox", { name: "Imagem ou vídeo" }));

    expect(
      await screen.findByText("Foto da clínica (não pode ser enviada agora: sem termo de uso de imagem)"),
    ).toBeTruthy();
  });
});
