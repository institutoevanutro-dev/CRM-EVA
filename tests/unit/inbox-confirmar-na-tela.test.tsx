/**
 * I6 (passo 1): o que não tem volta limpa pergunta NA TELA, nunca por
 * `window.confirm`. Fechar nasce com o foco em "Fechar conversa" (`e` + Enter
 * continua fechando); excluir nota interna pergunta antes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ConfirmarNaTela } from "@/components/inbox/ConfirmarNaTela";
import { NoteCard } from "@/components/inbox/NoteCard";
import type { Note } from "@/lib/types/messaging";

describe("I6 — confirmar na tela", () => {
  it("nenhum confirm() do navegador sobra no Inbox", () => {
    for (const f of [
      "components/inbox/ConversationHeader.tsx",
      "components/inbox/InboxKeyboardShortcuts.tsx",
      "components/inbox/InboxLayout.tsx",
      "components/inbox/NoteCard.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/(?<![.\w])confirm\(/);
    }
  });

  it("com focoNaAcao, o foco nasce na ação e Enter confirma", () => {
    const onConfirmar = vi.fn();
    render(
      <ConfirmarNaTela aberto onAbertoChange={() => {}} titulo="Fechar esta conversa?"
        descricao="O atendimento termina." acao="Fechar conversa" focoNaAcao onConfirmar={onConfirmar} />,
    );
    const acao = screen.getByRole("button", { name: "Fechar conversa" });
    expect(document.activeElement).toBe(acao);
    fireEvent.click(acao);
    expect(onConfirmar).toHaveBeenCalledTimes(1);
  });

  it("excluir nota interna pergunta antes, e a lixeira não depende do mouse", () => {
    const onDelete = vi.fn();
    const note = {
      id: "n1", conversation_id: "c1", body: "Ligar amanhã", created_at: "2026-11-08T12:00:00.000Z",
      created_by_name: "Pessoa de Teste", created_by_user_id: "u1", media_storage_path: null,
    } as unknown as Note;
    render(<NoteCard note={note} onDelete={onDelete} />);
    const lixeira = screen.getByRole("button", { name: "Excluir nota" });
    expect(lixeira.className).toContain("opacity-100");
    expect(lixeira.className).toContain("focus-visible:opacity-100");
    fireEvent.click(lixeira);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Excluir esta nota interna?");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Não dá para desfazer.");
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
