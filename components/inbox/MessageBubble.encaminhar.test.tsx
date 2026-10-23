/**
 * O botão "Encaminhar" ao lado da bolha (DeskcommCRM #2835; portado do projeto
 * original, PR #2841). No fork ele mora ao lado do "Responder", fora da bolha.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "received",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "crm",
    sent_by_user_id: null,
    sent_at: "2026-09-08T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

describe("MessageBubble — encaminhar", () => {
  it.each(["inbound", "outbound"] as const)("mensagem %s: o toque entrega a própria mensagem a quem encaminha", (direction) => {
    const onEncaminhar = vi.fn();
    const mensagem = msg({ direction });
    render(<MessageBubble message={mensagem} onEncaminhar={onEncaminhar} />);
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar" }));
    expect(onEncaminhar).toHaveBeenCalledWith(mensagem);
  });

  it("mensagem apagada não se encaminha: o conteúdo saiu do ar de propósito", () => {
    render(<MessageBubble message={msg({ revoked_at: "2026-09-24T11:00:00Z" })} onEncaminhar={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Encaminhar" })).toBeNull();
  });

  it("sem quem encaminhe (quem só lê) não há botão", () => {
    render(<MessageBubble message={msg()} />);
    expect(screen.queryByRole("button", { name: "Encaminhar" })).toBeNull();
  });
});
