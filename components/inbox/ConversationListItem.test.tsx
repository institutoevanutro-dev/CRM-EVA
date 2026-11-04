// Portado do projeto original (DeskcommCRM, PR #3665 de @webtecnica).
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

describe("ConversationListItem — etiquetas que não couberam (#3649)", () => {
  it("o +N diz no title quais etiquetas ficaram de fora", () => {
    render(<ConversationListItem conversation={conversa} isSelected={false} onSelect={() => {}} />);
    expect(screen.getByText("+2")).toHaveAttribute("title", "retorno, boleto");
  });
});
