/**
 * Conversa num canal que só RECEBE (o Instagram da etapa 1): o composer não
 * deixa escrever a resposta e diz por quê. A nota interna segue liberada, porque
 * ela nunca sai para o cliente.
 *
 * Antes, a resposta saía do composer e ficava `queued` para sempre.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  CHANNEL_PROVIDER_INSTAGRAM,
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_WAHA,
  canalRespondePeloCrm,
} from "@/lib/channels/capabilities";

const sendMock = vi.fn();
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
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

const MOTIVO = "Responder pelo Instagram chega na próxima versão; responda pelo app do Instagram por enquanto.";

describe("canalRespondePeloCrm decide pela capability", () => {
  it("canal que só recebe → false; canais que enviam → true; provider ainda não lido → true", () => {
    expect(canalRespondePeloCrm(CHANNEL_PROVIDER_INSTAGRAM)).toBe(false);
    expect(canalRespondePeloCrm(CHANNEL_PROVIDER_WAHA)).toBe(true);
    expect(canalRespondePeloCrm(CHANNEL_PROVIDER_META)).toBe(true);
    expect(canalRespondePeloCrm(null)).toBe(true);
  });
});

describe("Composer num canal que não envia", () => {
  function renderComposer() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer conversationId="conv-1" semEnvio={MOTIVO} />
      </QueryClientProvider>,
    );
  }

  it("mostra o motivo e trava a resposta", () => {
    renderComposer();
    expect(screen.getByText(MOTIVO)).toBeInTheDocument();
    expect(screen.getByLabelText(/mensagem/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /anexar/i })).toBeDisabled();
  });

  it("a nota interna continua liberada", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    expect(screen.getByPlaceholderText(/nota interna/i)).not.toBeDisabled();
    expect(screen.queryByText(MOTIVO)).not.toBeInTheDocument();
  });
});
