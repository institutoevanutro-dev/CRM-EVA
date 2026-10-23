import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * A FAIXA DE CIMA DO CAMPO (Responder / Nota interna, e o bloco da assistência
 * quando há sugestão; sem sugestão, "Sugerir resposta" é um ícone na linha de
 * ações, porte do original #3234) começa recolhida — pedido do dono, ela comia
 * a conversa o tempo todo — e
 * aparece pelo mouse, pelo foco ou pelo botão "Opções de resposta". O que este
 * arquivo prende é o lado que NÃO pode quebrar: o interruptor Responder/Nota
 * continua alcançável por teclado e toque, e o modo Nota nunca fica escondido.
 */

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
  const faixa = screen.getByRole("group", { name: "Assistência do agente e nota interna" });
  const alternador = screen.getByRole("button", { name: "Opções de resposta" });
  return { faixa, alternador };
}

const escondida = (faixa: HTMLElement) =>
  faixa.dataset.visivel === "false" && faixa.className.split(/\s+/).includes("invisible");

describe("composer — faixa de assistência recolhida", () => {
  it("nasce recolhida, com o botão explícito ao lado do campo", () => {
    const { faixa, alternador } = renderComposer();
    expect(escondida(faixa)).toBe(true);
    expect(alternador.getAttribute("aria-expanded")).toBe("false");
    expect(alternador.getAttribute("aria-controls")).toBe(faixa.id);
  });

  it("o botão (toque/teclado) abre, e o interruptor Responder/Nota fica à mão", () => {
    const { faixa, alternador } = renderComposer();
    fireEvent.click(alternador);
    expect(escondida(faixa)).toBe(false);
    expect(screen.getByRole("button", { name: "Responder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nota interna" })).toBeTruthy();
  });

  it("em Nota interna a faixa fica PRESA aberta e no fluxo — o modo nunca some", () => {
    const { faixa, alternador } = renderComposer();
    fireEvent.click(alternador);
    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(escondida(faixa)).toBe(false);
    expect(faixa.className).not.toContain("absolute");
    expect((alternador as HTMLButtonElement).disabled, "fechar não é opção em nota").toBe(true);
    // Escape não esconde o modo.
    fireEvent.keyDown(screen.getByRole("button", { name: "Nota interna" }), { key: "Escape" });
    expect(escondida(faixa)).toBe(false);
  });

  it("digitar no campo NÃO abre a faixa por cima da última mensagem", () => {
    const { faixa } = renderComposer();
    const campo = screen.getByRole("textbox");
    fireEvent.focus(campo);
    expect(escondida(faixa)).toBe(true);
  });
});
