/**
 * O diálogo de encaminhar zera a busca por qualquer caminho de fechar.
 *
 * Antes, só o fechar do próprio Dialog (X ou Esc) zerava: Cancelar chamava o pai
 * direto, e o encaminhamento que dava certo fechava pelo pai também. A lupa
 * antiga reaparecia na próxima mensagem e escondia as conversas.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EncaminharDialog } from "@/components/inbox/EncaminharDialog";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

afterEach(cleanup);

const conversas = [
  { id: "c-1", contacts: { display_name: "Maria Exemplo", phone_number: "+5511900000001" } },
  { id: "c-2", contacts: { display_name: "João Fictício", phone_number: "+5511900000002" } },
] as unknown as ConversationWithContact[];

function dialogo(open: boolean, onOpenChange = vi.fn()) {
  return (
    <EncaminharDialog
      open={open}
      onOpenChange={onOpenChange}
      conversas={conversas}
      conversationIdAtual={null}
      enviando={false}
      onEscolher={vi.fn()}
    />
  );
}

describe("encaminhar: a busca não sobrevive ao fechar", () => {
  it("fechado pelo pai (Cancelar ou encaminhamento concluído), reabre com a busca vazia e todas as conversas", () => {
    const { rerender } = render(dialogo(true));
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar conversa" }), { target: { value: "maria" } });
    expect(screen.queryByRole("button", { name: "João Fictício" })).toBeNull();

    rerender(dialogo(false));
    rerender(dialogo(true));

    expect(screen.getByRole("textbox", { name: "Buscar conversa" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "João Fictício" })).toBeTruthy();
  });

  it("Cancelar pede ao pai para fechar", () => {
    const fechar = vi.fn();
    render(dialogo(true, fechar));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(fechar).toHaveBeenCalledWith(false);
  });
});
