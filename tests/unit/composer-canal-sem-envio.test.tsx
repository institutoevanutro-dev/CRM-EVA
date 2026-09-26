/**
 * Conversa num canal que só RECEBE (nenhum hoje; foi o Instagram da etapa 1): o composer não
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

const MOTIVO = "Este canal ainda não envia pelo CRM; responda pelo app dele por enquanto.";

describe("canalRespondePeloCrm decide pela capability", () => {
  it("canais que enviam → true (o Instagram desde a etapa 2); provider ainda não lido → true", () => {
    expect(canalRespondePeloCrm(CHANNEL_PROVIDER_INSTAGRAM)).toBe(true);
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
