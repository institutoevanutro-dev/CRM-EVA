/**
 * Item 43 da auditoria de 17/11: no menu do "/", setas e Enter escolhem a
 * resposta rápida (antes só o mouse), e a lista se chama "Respostas rápidas".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const enviar = vi.fn();
vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: enviar, isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({ useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [
      { id: "1", title: "Saudação", body: "Olá, tudo bem?", shortcut: "oi" },
      { id: "2", title: "Endereço", body: "Rua das Flores, 100", shortcut: "end" },
    ],
    isLoading: false,
  }),
}));

import { Composer } from "@/components/inbox/Composer";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" contact={{ name: "Paciente Fictícia", display_name: null }} />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;
}

describe("item 43 — respostas rápidas pelo teclado", () => {
  it("⭐ '/', seta para baixo e Enter põem a SEGUNDA resposta no campo, sem enviar", () => {
    const campo = montar();
    fireEvent.change(campo, { target: { value: "/" } });
    const lista = screen.getByRole("listbox", { name: "Respostas rápidas" });
    expect(lista).toBeInTheDocument();

    fireEvent.keyDown(campo, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Endereço/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(campo, { key: "Enter" });

    expect(campo.value).toBe("Rua das Flores, 100");
    expect(enviar).not.toHaveBeenCalled();
  });
});
