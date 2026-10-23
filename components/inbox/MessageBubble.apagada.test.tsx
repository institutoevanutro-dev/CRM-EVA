/**
 * A bolha da mensagem apagada ("apagar para todos"): cinza, diz QUEM apagou, e
 * o texto continua fora da tela nos dois sentidos.
 *
 * Portado do projeto original (DeskcommCRM, PR #3279). No fork o texto da
 * apagada não aparece em nenhum sentido (regra de antes, que o porte mantém).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

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
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
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

describe("MessageBubble — mensagem apagada", () => {
  it("apagada pelo ATENDENTE: cinza, diz quem apagou e não mostra o texto", () => {
    render(<MessageBubble message={msg({ revoked_at: "2026-09-24T11:00:00Z", body: "valor combinado" })} />);
    expect(screen.getByText("Esta mensagem foi apagada pelo atendente")).toBeInTheDocument();
    expect(screen.queryByText("valor combinado")).not.toBeInTheDocument();
    const classes = screen.getByTestId("message-bubble").className;
    // Cinza: a apagada sai das cores da direção — a variável do balão da equipe é o envio vivo.
    expect(classes).toContain("bg-muted/60");
    expect(classes).not.toContain("bolha-enviada-fundo");
  });

  it("apagada pelo CONTATO: cinza, diz quem apagou e NÃO mostra o texto", () => {
    render(<MessageBubble message={msg({ direction: "inbound", revoked_at: "2026-09-24T11:00:00Z", body: "texto do cliente" })} />);
    expect(screen.getByText("Esta mensagem foi apagada pelo contato")).toBeInTheDocument();
    expect(screen.queryByText("texto do cliente")).not.toBeInTheDocument();
    const classes = screen.getByTestId("message-bubble").className;
    expect(classes).toContain("bg-muted/60");
    expect(classes).not.toContain("bolha-recebida-fundo");
  });

  it("CONTROLE: a mensagem viva segue com as cores da direção", () => {
    render(<MessageBubble message={msg()} />);
    const classes = screen.getByTestId("message-bubble").className;
    expect(classes).toContain("bolha-enviada-fundo");
    expect(classes).not.toContain("bg-muted/60");
  });
});
