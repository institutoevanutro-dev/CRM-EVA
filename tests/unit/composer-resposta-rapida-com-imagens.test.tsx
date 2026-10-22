import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

/**
 * A resposta rápida com imagens da Biblioteca de mídia, no compositor.
 *
 *   - escolher a resposta abre a PRÉVIA (não escreve no campo), com o texto como legenda;
 *   - enviar manda cada imagem como `media_library_item_id` (o envio da
 *     biblioteca, que confere o termo), a legenda só na primeira;
 *   - imagem recusada pelo servidor (422: sem termo, sumiu) é PULADA e as outras
 *     seguem; se nenhuma sai, o texto sai sozinho;
 *   - cancelar devolve o texto ao campo.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica).
 */

const send = vi.fn();
const ITEM_A = "9b1f0000-0000-4000-8000-0000000000a1";
const ITEM_B = "9b1f0000-0000-4000-8000-0000000000b2";

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), mutateAsync: send, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [{ id: "tpl-1", title: "Catálogo", body: "Oi {{primeiro_nome}}, veja!", shortcut: "cat", media_item_ids: [ITEM_A, ITEM_B] }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function escolher() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" contact={{ name: "Ana Souza", display_name: null }} />
    </QueryClientProvider>,
  );
  const campo = screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
  fireEvent.change(campo, { target: { value: "/cat" } });
  // Dentro do menu do `/`: a barra de respostas rápidas (#2833) mostra o mesmo título.
  fireEvent.click(within(screen.getByRole("listbox")).getByText("Catálogo"));
  return campo;
}

const enviar = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i, hidden: false }));
  });
};

describe("Composer · resposta rápida com imagens da biblioteca", () => {
  beforeEach(() => send.mockReset());

  it("abre a prévia com as imagens e o texto como legenda; o campo fica vazio", () => {
    const campo = escolher();
    expect(screen.getByTestId("imagens-da-resposta").querySelectorAll("img")).toHaveLength(2);
    expect(screen.getByLabelText("Legenda")).toHaveValue("Oi Ana, veja!");
    expect(campo.value).toBe("");
  });

  it("envia cada imagem pelo item da biblioteca, com a legenda só na primeira", async () => {
    send.mockResolvedValue({});
    escolher();
    await enviar();
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { conversation_id: "conv-1", type: "image", media_library_item_id: ITEM_A, body: "Oi Ana, veja!" },
      { conversation_id: "conv-1", type: "image", media_library_item_id: ITEM_B },
    ]);
  });

  it("imagem recusada (422) é pulada e a legenda vai com a próxima", async () => {
    send.mockRejectedValueOnce(new ApiError(422, "media_not_ready", undefined, "", "sem termo")).mockResolvedValue({});
    escolher();
    await enviar();
    expect(send.mock.calls.map((c) => c[0].media_library_item_id ?? "texto")).toEqual([ITEM_A, ITEM_B]);
    expect(send.mock.calls[1]![0].body).toBe("Oi Ana, veja!");
  });

  it("nenhuma imagem saiu: o texto sai sozinho", async () => {
    send
      .mockRejectedValueOnce(new ApiError(422, "media_not_found", undefined, "", ""))
      .mockRejectedValueOnce(new ApiError(422, "media_not_ready", undefined, "", ""))
      .mockResolvedValue({});
    escolher();
    await enviar();
    expect(send.mock.calls[2]![0]).toEqual({ conversation_id: "conv-1", body: "Oi Ana, veja!" });
  });

  it("cancelar devolve o texto ao campo e nada é enviado", () => {
    const campo = escolher();
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(campo.value).toBe("Oi Ana, veja!");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Composer · falha que não é recusa do item", () => {
  beforeEach(() => send.mockReset());

  it("a fila para, a prévia fica com o que faltou e a legenda já enviada não repete", async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError(500, "internal_error", undefined, "", ""));
    escolher();
    await enviar();
    expect(screen.getByTestId("imagens-da-resposta").querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByLabelText("Legenda")).toHaveValue("");
    send.mockResolvedValue({});
    await enviar();
    expect(send.mock.calls[2]![0]).toEqual({ conversation_id: "conv-1", type: "image", media_library_item_id: ITEM_B });
  });
});
