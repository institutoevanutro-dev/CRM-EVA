import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Quem chega pelo WhatsApp costuma ter só o nome do PERFIL (`display_name`) —
 * `contacts.name` fica vazio. O modelo com {{primeiro_nome}} escolhido no
 * composer tem de sair com esse nome, e não com a variável crua. O composer
 * recebe o contato inteiro e o helper resolve o nome; nada no meio do caminho
 * pode reduzir o contato a `name`.
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
  useMessageTemplates: () => ({
    data: [{ id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}, tudo bem?", shortcut: "oi" }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function escolherModelo(contact: { name: string | null; display_name: string | null }) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" contact={contact} />
    </QueryClientProvider>,
  );
  const campo = screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
  fireEvent.change(campo, { target: { value: "/oi" } });
  fireEvent.click(screen.getByText("Saudação"));
  return campo.value;
}

describe("Composer · modelo com {{primeiro_nome}}", () => {
  it("contato só com o nome do perfil (display_name) → o nome sai preenchido", () => {
    expect(escolherModelo({ name: null, display_name: "Ana Souza" })).toBe("Oi Ana, tudo bem?");
  });

  it("sem nome nenhum, a caixa de entrada mantém a variável para quem envia corrigir", () => {
    expect(escolherModelo({ name: null, display_name: "5511999998888" })).toBe("Oi {{primeiro_nome}}, tudo bem?");
  });
});
