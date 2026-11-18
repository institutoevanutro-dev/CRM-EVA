// Etiquetas saíram da linha em 18/11/2026 (linha de app de mensagem, pedido do
// André): elas moram no painel do contato e no filtro por etiqueta. Este arquivo
// guardava o "+N" do porte #3649 (DeskcommCRM, de @webtecnica), que deixou de
// existir junto com os chips.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "./ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const conversa = {
  id: "c1", organization_id: "org", contact_id: "ct1", channel_session_id: "s1",
  channel: "whatsapp", status: "open", last_message_at: new Date().toISOString(),
  last_message_preview: "olá", unread_count_for_assignee: 0, created_at: new Date().toISOString(),
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+595999",
    tags: ["vip", "quente", "retorno", "boleto"], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

describe("ConversationListItem — etiquetas fora da linha", () => {
  it("nenhum chip de etiqueta nem '+N' na linha", () => {
    render(<ConversationListItem conversation={conversa} isSelected={false} onSelect={() => {}} />);
    for (const etiqueta of ["vip", "quente", "+2"]) {
      expect(screen.queryByText(etiqueta), etiqueta).toBeNull();
    }
  });
});
