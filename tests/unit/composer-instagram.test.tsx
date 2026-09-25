/**
 * O COMPOSITOR SOB AS REGRAS DO INSTAGRAM — etapa 2.
 *
 * O Direct tem limite de texto (1000 caracteres) e só manda foto — nem
 * documento, nem contato, nem áudio (o gravador grava ogg/opus, que o Direct
 * não aceita). `InboxLayout` (Task 6) decide isso pela capability do
 * provider; este arquivo prova que o `Composer` e o `AttachMenu` OBEDECEM as
 * duas props novas (`limiteDeTexto`, `soFoto`) sem tocar em nada do WhatsApp.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" {...props} />
    </QueryClientProvider>,
  );
}

describe("limiteDeTexto no compositor", () => {
  it("sem limiteDeTexto: nenhum contador aparece (canal comum não conta)", () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "oi" } });
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
  });

  it("dentro do limite: contador visível e envio liberado", () => {
    renderComposer({ limiteDeTexto: 1000 });
    const texto = "a".repeat(999);
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: texto } });
    expect(screen.getByText("999/1000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enviar/i })).not.toBeDisabled();
  });

  it("passou do limite: contador visível e envio desabilitado", () => {
    renderComposer({ limiteDeTexto: 1000 });
    const texto = "a".repeat(1001);
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: texto } });
    expect(screen.getByText("1001/1000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
  });
});

describe("soFoto no compositor", () => {
  it("esconde o gravador de áudio (o Direct não aceita a mídia que ele grava)", () => {
    renderComposer({ soFoto: true });
    expect(screen.queryByRole("button", { name: /gravar|áudio/i })).not.toBeInTheDocument();
  });

  it("com texto ainda mostra o botão de enviar, nunca o gravador", () => {
    renderComposer({ soFoto: true });
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "oi" } });
    expect(screen.getByRole("button", { name: /enviar/i })).toBeInTheDocument();
  });
});

describe("AttachMenu com soFoto", () => {
  it("mostra só Fotos — sem Documento nem Contato", () => {
    render(<AttachMenu soFoto onPick={vi.fn()} onPickContact={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    expect(screen.getByText("Fotos")).toBeInTheDocument();
    expect(screen.queryByText("Documento")).not.toBeInTheDocument();
    expect(screen.queryByText("Contato")).not.toBeInTheDocument();
  });

  it("o input de foto aceita só jpeg/png", () => {
    render(<AttachMenu soFoto onPick={vi.fn()} onPickContact={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png");
  });

  it("sem soFoto, o menu de sempre segue com as três opções", () => {
    render(<AttachMenu onPick={vi.fn()} onPickContact={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    expect(screen.getByText("Fotos e vídeos")).toBeInTheDocument();
    expect(screen.getByText("Documento")).toBeInTheDocument();
    expect(screen.getByText("Contato")).toBeInTheDocument();
  });
});
