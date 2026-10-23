import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * O COMPOSER NO CELULAR (porte dos originais #3190 e #3191).
 *
 * Campo com menos de 16px faz o Safari do iPhone AMPLIAR a página ao focar, e
 * o zoom muda a largura do `visualViewport`, o que confundia a detecção do
 * teclado da conversa em tela cheia. O jsdom não aplica CSS: aqui fica a
 * guarda da classe, e a medida em px só o navegador prova.
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
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

describe("campo de mensagem com 16px no celular (porte do #3190)", () => {
  it("usa text-base abaixo do md e text-sm a partir dele", () => {
    renderComposer();
    const campo = screen.getByRole("textbox", { name: "Mensagem" });
    const classes = campo.className.split(/\s+/);
    expect(classes).toContain("text-base");
    expect(classes).toContain("md:text-sm");
    expect(classes).not.toContain("text-sm");
  });
});
