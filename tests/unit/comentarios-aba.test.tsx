/**
 * A aba "Comentários" do Inbox (Task 8 de 9 — "comentários no CRM"): a fila de
 * `instagram_comments` que espera um toque humano, com a sugestão da IA e os
 * dois botões, mais o formulário que cria uma regra em
 * `instagram_comment_rules`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ListaDeComentarios,
  type ComentarioDaFila,
} from "@/components/inbox/comentarios/ListaDeComentarios";
import { FormularioDeRegra } from "@/components/inbox/comentarios/FormularioDeRegra";
import { InboxFilters, visibleInboxTabs, type InboxFiltersValue } from "@/components/inbox/InboxFilters";

// Mesmo dublê de `tests/unit/inbox-filtro-canal.test.tsx`: `InboxFilters`
// carrega auth/canais/tags/contagens por hook, e a asserção aqui é só sobre a
// aba — não sobre nenhum desses dados.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" } }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof import("@/hooks/channels/useChannelSessions")>();
  return { ...real, useChannelSessions: () => ({ data: [] }) };
});
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: {} }),
}));

const atendido: ComentarioDaFila = {
  id: "c1",
  texto: "obrigado pela resposta!",
  media_id: "m1",
  autor_handle: "@cliente1",
  comentado_em: "2026-09-26T10:00:00.000Z",
  situacao: "respondido_pela_regra",
  sugestao_de_resposta: null,
  motivo_do_toque: null,
};

const esperando: ComentarioDaFila = {
  id: "c2",
  texto: "quanto custa esse procedimento?",
  media_id: "m1",
  autor_handle: "@cliente2",
  comentado_em: "2026-09-26T11:00:00.000Z",
  situacao: "esperando_voce",
  sugestao_de_resposta: "Chame no Direct que a gente te passa o valor certinho!",
  motivo_do_toque: "preço",
};

describe("ListaDeComentarios", () => {
  it("mostra primeiro o que espera você, com a sugestão e os dois botões", () => {
    render(<ListaDeComentarios comentarios={[atendido, esperando]} />);
    const itens = screen.getAllByRole("listitem");
    expect(itens[0]).toHaveTextContent("quanto custa");
    expect(screen.getByRole("button", { name: "Publicar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
  });

  it("diz por que o comentário está esperando", () => {
    render(<ListaDeComentarios comentarios={[esperando]} />);
    expect(screen.getByText(/preço/i)).toBeTruthy();
  });

  it("comentário atendido pela regra não oferece Publicar", () => {
    render(<ListaDeComentarios comentarios={[atendido]} />);
    expect(screen.queryByRole("button", { name: "Publicar" })).toBeNull();
  });

  it("sem nenhum comentário, diz que a fila está vazia", () => {
    render(<ListaDeComentarios comentarios={[]} />);
    expect(screen.getByText(/nenhum comentário/i)).toBeTruthy();
  });

  it("Publicar manda o texto atual (a sugestão, sem edição) para quem chamou", () => {
    const onPublicar = vi.fn();
    render(<ListaDeComentarios comentarios={[esperando]} onPublicar={onPublicar} />);
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    expect(onPublicar).toHaveBeenCalledWith("c2", esperando.sugestao_de_resposta);
  });

  it("Editar abre a caixa de texto, e o que for digitado é o que Publicar manda", () => {
    const onPublicar = vi.fn();
    render(<ListaDeComentarios comentarios={[esperando]} onPublicar={onPublicar} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const caixa = screen.getByRole("textbox", { name: /editar a resposta/i });
    fireEvent.change(caixa, { target: { value: "Resposta reescrita à mão" } });
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    expect(onPublicar).toHaveBeenCalledWith("c2", "Resposta reescrita à mão");
  });
});

describe("FormularioDeRegra", () => {
  it("só habilita Criar regra com os quatro campos preenchidos, e manda o payload certo", () => {
    const onCriar = vi.fn();
    render(<FormularioDeRegra onCriar={onCriar} />);
    const botao = screen.getByRole("button", { name: "Criar regra" });
    expect(botao).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Mídia (id do post)"), { target: { value: "17900" } });
    fireEvent.change(screen.getByLabelText("Palavra-gatilho"), { target: { value: "preço" } });
    fireEvent.change(screen.getByLabelText("Mensagem no Direct"), {
      target: { value: "O valor é R$150." },
    });
    fireEvent.change(screen.getByLabelText("Resposta pública"), {
      target: { value: "Te chamamos no Direct!" },
    });
    expect(botao).not.toBeDisabled();

    fireEvent.click(botao);
    expect(onCriar).toHaveBeenCalledWith({
      media_id: "17900",
      palavra: "preço",
      texto_do_direct: "O valor é R$150.",
      frase_publica: "Te chamamos no Direct!",
    });
  });
});

describe("aba Comentários no Inbox", () => {
  it("aparece na faixa de abas, para qualquer papel", () => {
    expect(visibleInboxTabs("viewer", undefined)).toContain("comentarios");
    expect(visibleInboxTabs("agent", "own")).toContain("comentarios");
  });

  it("selecionada, esconde a busca de conversa (que não filtra comentário nenhum)", () => {
    const value: InboxFiltersValue = { tab: "comentarios", search: "", onlyUnread: false };
    render(<InboxFilters value={value} onChange={() => {}} />);
    expect(screen.queryByLabelText("Buscar conversas")).toBeNull();
  });
});
