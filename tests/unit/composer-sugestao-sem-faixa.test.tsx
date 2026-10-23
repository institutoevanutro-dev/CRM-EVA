/**
 * A ASSISTÊNCIA DO AGENTE SÓ É MONTADA COM SUGESTÃO (porte do original #3234).
 *
 * Antes, o `ReplyReviewPanel` era montado sempre em modo resposta, dentro da
 * faixa recolhida de cima do campo: sem sugestão, uma linha "Assistência do
 * agente" com o botão "Sugerir resposta", e quem queria uma sugestão tinha de
 * abrir a faixa primeiro. Agora:
 *   (1) sem sugestão: o bloco não é montado e sobra UM botão, o ícone da linha
 *       de ações;
 *   (2) com sugestão (preparando, para revisar, aprovada): o bloco aparece
 *       inteiro e o ícone sai de cena;
 *   (3) enviada, descartada ou obsoleta: o bloco sai e o ícone volta;
 *   (4) nunca dois botões "Sugerir resposta" no mesmo estado;
 *   (5) o clique no ícone gera pelo MESMO POST do bloco, e é o rascunho criado
 *       que monta o bloco;
 *   (6) a confirmação da rejeição sobrevive à saída do bloco (toast).
 *
 * O `Composer`, o `ReplyReviewPanel` e o `DraftReplyButton` são os REAIS: só a
 * rede (`apiClient`), o toast e os hooks de envio são dublês.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  rascunhos: [] as unknown[],
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: deps.get, post: deps.post } }));
vi.mock("sonner", () => ({
  toast: { success: deps.toastSuccess, error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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

/** Um rascunho como o servidor devolve, só com os campos que a tela lê. */
const rascunho = (extra: Record<string, unknown> = {}) => ({
  id: "d1",
  revision: "1",
  status: "pending",
  original_body: "Oi, tudo bem?",
  edited_body: null,
  error_code: null,
  proposals: [],
  ...extra,
});

function comRascunhos(drafts: unknown[]) {
  deps.rascunhos = drafts;
}

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" {...props} />
    </QueryClientProvider>,
  );
}

/** O bloco, pelo rótulo dele (a faixa que o contém tem outro nome). */
const bloco = () => screen.queryByLabelText("Assistência do agente");
const botoesDeSugerir = () => screen.queryAllByRole("button", { name: "Sugerir resposta" });
const getsDosRascunhos = () =>
  deps.get.mock.calls.filter(([url]) => String(url).endsWith("/draft-reply")).length;

beforeEach(() => {
  deps.get.mockReset();
  deps.post.mockReset();
  deps.toastSuccess.mockReset();
  deps.rascunhos = [];
  deps.get.mockImplementation(async (url: string) =>
    url.endsWith("/draft-reply") ? { data: { drafts: deps.rascunhos } } : { data: [] },
  );
});

describe("a assistência do agente só ocupa a tela com sugestão (#3234)", () => {
  it("⭐ sem rascunho: o bloco NÃO é montado e sobra UM botão, o ícone", async () => {
    comRascunhos([]);
    renderComposer();

    await waitFor(() => expect(getsDosRascunhos()).toBeGreaterThan(0));
    expect(await screen.findByLabelText("Sugerir resposta")).toBeTruthy();
    expect(bloco(), "o bloco apareceu sem rascunho").toBeNull();
    expect(screen.queryByText("Assistência do agente")).toBeNull();
    expect(screen.queryByRole("button", { name: "Aprovar e enviar" })).toBeNull();
    expect(botoesDeSugerir()).toHaveLength(1);
  });

  it("CONTROLE: com rascunho para revisar, o bloco volta com o texto e as ações", async () => {
    comRascunhos([rascunho({ status: "pending" })]);
    renderComposer();

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(bloco()).toBeTruthy();
    expect(screen.getByLabelText("Resposta sugerida")).toHaveValue("Oi, tudo bem?");
    expect(screen.getByRole("button", { name: "Aprovar e enviar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rejeitar" })).toBeTruthy();
    // Um só: o do bloco; o ícone saiu de cena.
    expect(botoesDeSugerir()).toHaveLength(1);
    // E com sugestão na tela a faixa fica presa aberta (o alternador trava).
    expect(screen.getByRole("button", { name: "Opções de resposta" })).toBeDisabled();
  });

  it("CONTROLE: rascunho preparando e rascunho aprovado também mantêm o bloco", async () => {
    comRascunhos([rascunho({ status: "generating", original_body: null })]);
    const primeira = renderComposer();
    expect(await screen.findByText("Preparando sugestão…")).toBeTruthy();
    expect(bloco()).toBeTruthy();
    primeira.unmount();

    comRascunhos([rascunho({ status: "approved" })]);
    renderComposer();
    expect(await screen.findByText("Resposta aprovada: aguardando envio")).toBeTruthy();
    expect(bloco()).toBeTruthy();
    expect(botoesDeSugerir()).toHaveLength(1);
  });

  it("CONTROLE: enviado, descartado ou obsoleto, o bloco sai e o ícone volta", async () => {
    for (const status of ["sent", "dismissed", "stale"]) {
      deps.get.mockClear();
      comRascunhos([rascunho({ status })]);
      const { unmount } = renderComposer();

      await waitFor(() => expect(getsDosRascunhos()).toBeGreaterThan(0));
      expect(await screen.findByLabelText("Sugerir resposta")).toBeTruthy();
      expect(bloco(), `com status ${status} o bloco continuou na tela`).toBeNull();
      expect(botoesDeSugerir()).toHaveLength(1);
      unmount();
    }
  });

  it("CONTROLE: em NOTA não há bloco nem ícone; de volta a Responder, o bloco volta", async () => {
    comRascunhos([rascunho()]);
    renderComposer();
    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(bloco()).toBeNull();
    expect(botoesDeSugerir()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(bloco()).toBeTruthy();
  });

  it("⭐ compositor bloqueado não consulta rascunho (quem só lê levaria 403 no GET)", async () => {
    comRascunhos([rascunho()]);
    renderComposer({ blockedReason: "Acompanhamento somente leitura" });

    expect(await screen.findByText("Acompanhamento somente leitura")).toBeTruthy();
    // A consulta subiu do painel para o compositor; ela não pode sair sozinha
    // com o compositor bloqueado, que antes nem deixava o painel montar.
    expect(getsDosRascunhos()).toBe(0);
  });

  it("⭐ o clique no ícone gera pelo mesmo POST, e é o rascunho criado que monta o bloco", async () => {
    comRascunhos([]);
    deps.post.mockResolvedValue({ data: { draft: "texto gerado" } });
    renderComposer();

    await waitFor(() => expect(getsDosRascunhos()).toBeGreaterThan(0));
    const icone = await screen.findByLabelText("Sugerir resposta");
    expect(bloco(), "o bloco já estava na tela antes de haver rascunho").toBeNull();
    // O rascunho nasce no servidor; a próxima leitura da consulta já o traz.
    comRascunhos([rascunho({ status: "pending", original_body: "Sugestão do agente" })]);
    fireEvent.click(icone);

    await waitFor(() =>
      expect(deps.post).toHaveBeenCalledWith("/api/v1/conversations/conv-1/draft-reply", {}),
    );
    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.getByLabelText("Resposta sugerida")).toHaveValue("Sugestão do agente");
    expect(botoesDeSugerir()).toHaveLength(1);
    // O texto não cai no campo: quem revisa e decide é o bloco.
    expect(screen.getByLabelText("Mensagem")).toHaveValue("");
  });

  it("⭐ a confirmação da rejeição sobrevive ao bloco que sai (toast)", async () => {
    comRascunhos([rascunho({ status: "pending" })]);
    deps.post.mockResolvedValue({ data: {} });
    renderComposer();

    await screen.findByText("Sugestão para revisar");
    // O servidor passa a responder com a sugestão DESCARTADA, como no fluxo real.
    comRascunhos([rascunho({ status: "dismissed" })]);
    fireEvent.click(screen.getByRole("button", { name: "Rejeitar" }));

    await waitFor(() =>
      expect(deps.toastSuccess).toHaveBeenCalledWith(
        "Sugestão rejeitada. O feedback será usado na próxima sugestão.",
      ),
    );
    await waitFor(() => expect(bloco()).toBeNull());
    expect(await screen.findByLabelText("Sugerir resposta")).toBeTruthy();
    // A decisão foi o MESMO POST do bloco, com a revisão e o feedback.
    expect(deps.post).toHaveBeenCalledWith("/api/v1/ai/replies/d1", {
      action: "reject",
      revision: "1",
      body: "Oi, tudo bem?",
      feedback: "",
    });
  });
});
