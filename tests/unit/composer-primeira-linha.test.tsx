import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * I4 — A PRIMEIRA LINHA DO COMPOSITOR: [Responder | Nota interna] à esquerda,
 * "Respostas rápidas" e "Sugerir resposta" à direita, no fluxo e sempre à vista.
 * Substituiu a faixa recolhida que abria POR CIMA da última mensagem e o "⋯"
 * que a abria. O que este arquivo prende:
 *   - o modo está à vista sem gesto nenhum (nada de faixa a revelar);
 *   - o "⋯" do compositor não existe mais;
 *   - a segunda linha é [+], campo, emoji, enviar/microfone, nessa ordem;
 *   - "Nota interna" ativa usa o par de token warning-fg/on-warning.
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
    data: [{ id: "tpl-1", title: "Boas vindas", body: "Oi!", shortcut: null, owner_user_id: null }],
    isLoading: false,
  }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

const modo = () => screen.getByRole("group", { name: "Modo do compositor" });

describe("I4 — primeira linha do compositor", () => {
  it("o modo está à vista sem gesto, e o ⋯ do compositor saiu", () => {
    renderComposer();
    const responder = within(modo()).getByRole("button", { name: "Responder" });
    const nota = within(modo()).getByRole("button", { name: "Nota interna" });
    expect(responder.getAttribute("aria-pressed")).toBe("true");
    expect(nota.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Opções de resposta" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Assistência do agente e nota interna" })).toBeNull();
  });

  it("Respostas rápidas e Sugerir resposta moram na primeira linha, com texto", () => {
    renderComposer();
    const linha = modo().parentElement!;
    const rapidas = within(linha).getByRole("button", { name: /Respostas rápidas \(1\)/ });
    const sugerir = within(linha).getByRole("button", { name: "Sugerir resposta" });
    expect(rapidas.textContent).toContain("Respostas rápidas");
    expect(sugerir.textContent).toContain("Sugerir resposta");
    // A linha não cobre a conversa: está no fluxo.
    expect(linha.className).not.toContain("absolute");
  });

  it("segunda linha: [+], campo, emoji, microfone — nessa ordem", () => {
    renderComposer();
    const campo = screen.getByRole("textbox", { name: "Mensagem" });
    const ordem = Array.from(campo.parentElement!.children).map(
      (el) => el.getAttribute("aria-label") ?? el.querySelector("[aria-label]")?.getAttribute("aria-label"),
    );
    const i = (nome: string) => ordem.findIndex((n) => n?.startsWith(nome));
    expect(i("Anexar")).toBeGreaterThanOrEqual(0);
    expect(i("Anexar")).toBeLessThan(i("Mensagem"));
    expect(i("Mensagem")).toBeLessThan(i("Emoji"));
    expect(i("Emoji")).toBe(ordem.length - 2);
  });

  it("Nota interna pelo teclado: o botão troca o modo, e a pílula ativa usa o token", () => {
    renderComposer();
    const nota = within(modo()).getByRole("button", { name: "Nota interna" });
    nota.focus();
    fireEvent.click(nota); // Espaço/Enter num <button> chegam como click
    expect(nota.getAttribute("aria-pressed")).toBe("true");
    expect(nota.className).toContain("bg-warning-fg");
    expect(nota.className).toContain("text-on-warning");
    expect(screen.getByRole("textbox", { name: "Mensagem" }).getAttribute("placeholder")).toContain("nota interna");
    // Em nota, as ajudas de resposta ao cliente saem da linha.
    expect(screen.queryByRole("button", { name: "Sugerir resposta" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Respostas rápidas/ })).toBeNull();
  });
});
