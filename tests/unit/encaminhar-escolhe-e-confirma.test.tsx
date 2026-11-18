/**
 * Item 33 da auditoria de 17/11: encaminhar são dois gestos. O toque no nome só
 * marca o destino, a linha mostra o telefone (duas "Maria" deixam de ser
 * iguais) e quem envia é o botão que diz para quem.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EncaminharDialog } from "@/components/inbox/EncaminharDialog";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const conversas = [
  { id: "c-1", contacts: { display_name: "Maria Exemplo", phone_number: "+5527999990001" } },
  { id: "c-2", contacts: { display_name: "Maria Exemplo", phone_number: "+5527999990002" } },
] as unknown as ConversationWithContact[];

describe("encaminhar: escolhe, vê o telefone e confirma", () => {
  it("⭐ um toque no nome não encaminha; o botão 'Encaminhar para…' encaminha", () => {
    const onEscolher = vi.fn();
    render(
      <EncaminharDialog open onOpenChange={vi.fn()} conversas={conversas} conversationIdAtual={null}
        enviando={false} onEscolher={onEscolher} />,
    );
    const linhas = screen.getAllByRole("button", { name: /^Maria Exemplo/ });
    expect(linhas).toHaveLength(2);
    // O telefone separa as homônimas.
    expect(linhas[0]!.textContent).not.toBe(linhas[1]!.textContent);

    const enviar = screen.getByRole("button", { name: "Encaminhar" });
    expect(enviar).toBeDisabled();

    fireEvent.click(linhas[1]!);
    expect(onEscolher).not.toHaveBeenCalled();
    expect(linhas[1]).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Encaminhar para Maria Exemplo" }));
    expect(onEscolher).toHaveBeenCalledWith("c-2");
  });
});
