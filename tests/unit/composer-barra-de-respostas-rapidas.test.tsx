import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A barra de respostas rápidas do Inbox (#2833) usa o MESMO caminho do `/`:
 *
 *   - um botão por resposta cadastrada, só no modo de resposta ao cliente;
 *   - clicar na resposta de TEXTO põe o corpo interpolado no campo e NÃO envia;
 *   - clicar na resposta COM IMAGENS abre a mesma prévia do `/`, com o texto como
 *     legenda, e também não envia.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2847 de @webtecnica).
 */

const send = vi.fn();
const sendAsync = vi.fn();
const ITEM_A = "9b1f0000-0000-4000-8000-0000000000a1";

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: send, mutateAsync: sendAsync, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [
      { id: "tpl-texto", title: "Boas vindas", body: "Oi {{primeiro_nome}}, tudo bem?", shortcut: "oi", owner_user_id: null },
      { id: "tpl-img", title: "Catálogo", body: "Veja, {{primeiro_nome}}!", shortcut: null, owner_user_id: null, media_item_ids: [ITEM_A] },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function montar() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" contact={{ name: "Ana Souza", display_name: null }} />
    </QueryClientProvider>,
  );
  return screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
}

describe("Composer · barra de respostas rápidas", () => {
  beforeEach(() => {
    send.mockReset();
    sendAsync.mockReset();
  });

  it("mostra um botão por resposta cadastrada", () => {
    montar();
    const barra = screen.getByTestId("barra-de-recursos");
    expect(within(barra).getAllByRole("button").map((b) => b.textContent)).toEqual(["Boas vindas", "Catálogo"]);
  });

  it("texto: o corpo interpolado cai no campo, editável, e nada é enviado", () => {
    const campo = montar();
    fireEvent.click(within(screen.getByTestId("barra-de-recursos")).getByText("Boas vindas"));
    expect(campo.value).toBe("Oi Ana, tudo bem?");
    expect(send).not.toHaveBeenCalled();
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it("com imagem: abre a prévia do `/` com a legenda, e nada é enviado", () => {
    const campo = montar();
    fireEvent.click(within(screen.getByTestId("barra-de-recursos")).getByText("Catálogo"));
    expect(screen.getByTestId("imagens-da-resposta").querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByLabelText("Legenda")).toHaveValue("Veja, Ana!");
    expect(campo.value).toBe("");
    expect(send).not.toHaveBeenCalled();
    expect(sendAsync).not.toHaveBeenCalled();
  });
});
