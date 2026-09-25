import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

/**
 * Contato que chegou pelo Instagram não tem telefone: o rótulo cai no nome do
 * perfil, depois no @, e só então em "Contato do Instagram". Nunca "??".
 */
const conversa = (identidade: { handle: string | null; display_name: string | null }) =>
  ({
    id: "c",
    organization_id: "org",
    contact_id: "ct",
    channel: "instagram",
    status: "open",
    last_message_preview: "Oi",
    last_message_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    unread_count_for_assignee: 0,
    contacts: {
      id: "ct", display_name: null, name: null, phone_number: null, tags: [], is_blocked: false, is_anonymized: false,
      contact_channel_identities: [{ channel: "instagram", ...identidade }],
    },
    channel_sessions: { display_name: "@dr.andreluisc", phone_number: null, provider: null },
  }) as unknown as ConversationWithContact;

const pintar = (c: ConversationWithContact) =>
  render(<ConversationListItem conversation={c} isSelected={false} onSelect={() => {}} />);

describe("contato sem telefone no Inbox", () => {
  it("mostra o @ e o canal, nunca ??", () => {
    pintar(conversa({ handle: "maria", display_name: null }));
    expect(screen.queryByText("??")).toBeNull();
    expect(screen.getByText("@maria")).toBeTruthy();
    expect(screen.getByText(/via @dr\.andreluisc/)).toBeTruthy();
  });

  it("o nome do perfil vence o @", () => {
    pintar(conversa({ handle: "maria", display_name: "Maria Souza" }));
    expect(screen.getByText("Maria Souza")).toBeTruthy();
  });

  it("sem nome nem @: 'Contato do Instagram'", () => {
    expect(rotuloDoContato({ display_name: null, phone_number: null, contact_channel_identities: [{ channel: "instagram", handle: null, display_name: null }] })).toBe("Contato do Instagram");
  });

  it("contato de WhatsApp continua igual", () => {
    expect(rotuloDoContato({ display_name: null, phone_number: "+5511999998888" })).not.toBe("Sem nome");
    expect(rotuloDoContato({ display_name: null, phone_number: null })).toBe("Sem nome");
  });
});
