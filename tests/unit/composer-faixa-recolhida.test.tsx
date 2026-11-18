import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * RESPONDER / NOTA INTERNA SEMPRE À VISTA (item 44 da auditoria de 17/11).
 *
 * A faixa nascia recolhida — aberta pelo "⋯ Opções de resposta" ou pelo mouse —
 * e aí flutuava sobre a última mensagem. "Nota interna" ficava escondida
 * justamente de quem precisa saber, antes de escrever, se o texto vai ao
 * paciente ou fica com o time. Agora a faixa está sempre no fluxo, sem porta.
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
  return screen.getByRole("group", { name: "Assistência do agente e nota interna" });
}

const recolhida = (faixa: HTMLElement) => /\b(invisible|absolute)\b/.test(faixa.className);

describe("composer — Responder / Nota interna sempre à vista", () => {
  it("⭐ nasce à vista e no fluxo, sem o '⋯' para abrir", () => {
    const faixa = renderComposer();
    expect(recolhida(faixa)).toBe(false);
    expect(screen.getByRole("button", { name: "Responder" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Nota interna" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Opções de resposta" })).toBeNull();
  });

  it("trocar para Nota interna e de volta, sem a faixa sumir", () => {
    const faixa = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", expect.stringMatching(/nota interna/i));
    fireEvent.keyDown(screen.getByRole("button", { name: "Nota interna" }), { key: "Escape" });
    expect(recolhida(faixa)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Escreva uma mensagem…");
  });
});
