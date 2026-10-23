/**
 * A bolha da mensagem que falhou: o motivo à vista e o "Tentar de novo".
 *
 * Portado do projeto original (DeskcommCRM, PR #3192). Arquivo próprio, e não
 * o `MessageBubble.test.tsx`, para os portes paralelos não brigarem no mesmo
 * fim de arquivo. Sem provider de idioma o `t()` devolve o português.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import { ApiError } from "@/lib/api/types";
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

describe("MessageBubble — mensagem que falhou", () => {
  const agora = () => new Date().toISOString();

  it("diz o motivo à vista e oferece tentar de novo quando nada saiu", async () => {
    const onReenviar = vi.fn(async () => undefined);
    render(<MessageBubble message={msg({
      status: "failed", error_code: "storage_sign_failed", sent_by_user_id: "eu", updated_at: agora(),
    })} viewerUserId="eu" onReenviar={onReenviar} />);
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent("Não conseguimos preparar o arquivo para envio.");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(onReenviar).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), false));
  });

  it("o texto cru do canal não aparece na linha visível", () => {
    render(<MessageBubble message={msg({
      status: "failed", error_code: "canal_x_error", error_message: "fetch failed http://servico-interno:3000/api/sendText",
      sent_by_user_id: "eu",
    })} viewerUserId="eu" />);
    expect(screen.getByTestId("motivo-da-falha")).not.toHaveTextContent("http");
    expect(document.body.textContent).not.toContain("http://servico-interno");
  });

  // O tooltip do selo "Falhou" conta a MESMA frase da linha visível — antes ele
  // mostrava o `error_message` cru (porte do DeskcommCRM #3336).
  it("o tooltip do 'Falhou' diz a mesma frase da linha, sem o texto cru", async () => {
    render(<MessageBubble message={msg({
      status: "failed", error_code: "storage_sign_failed",
      error_message: "fetch failed http://servico-interno:3000/storage/v1/object/sign",
    })} />);
    fireEvent.focus(screen.getByText("Falhou"));
    const dica = await screen.findByRole("tooltip");
    const frase = "Não conseguimos preparar o arquivo para envio.";
    expect(dica).toHaveTextContent(frase);
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent(frase);
    expect(document.body.textContent).not.toContain("servico-interno");
  });

  it("código sem frase + texto cru: a genérica no tooltip e na linha, sem o endereço", async () => {
    render(<MessageBubble message={msg({
      status: "failed", error_code: "canal_x_error",
      error_message: "fetch failed http://servico-interno:3000/api/sendText",
    })} />);
    fireEvent.focus(screen.getByText("Falhou"));
    const dica = await screen.findByRole("tooltip");
    expect(dica).toHaveTextContent("Não foi possível enviar esta mensagem.");
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent("Não foi possível enviar esta mensagem.");
    expect(document.body.textContent).not.toContain("servico-interno");
  });

  it.each([
    ["pre_go_live", "Envio automático bloqueado pelo modo de teste do canal."],
    ["channel_archived", "Este número foi excluído da Central de Conexões."],
  ])("frase nossa gravada no envio (%s) aparece no tooltip e na linha", async (error_code, frase) => {
    render(<MessageBubble message={msg({ status: "failed", error_code, error_message: frase })} />);
    fireEvent.focus(screen.getByText("Falhou"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(frase);
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent(frase);
    expect(document.body.textContent).not.toContain("automação");
  });

  it("código sem frase cai na frase genérica", () => {
    render(<MessageBubble message={msg({ status: "failed", error_code: "codigo_novo" })} />);
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent("Não foi possível enviar esta mensagem.");
  });

  it("quando pode ter chegado, o toque abre a confirmação antes de enviar", async () => {
    const onReenviar = vi.fn(async () => undefined);
    render(<MessageBubble message={msg({
      status: "failed", error_code: "send_timeout", sent_by_user_id: "eu",
    })} viewerUserId="eu" onReenviar={onReenviar} />);
    expect(screen.getByTestId("motivo-da-falha")).toHaveTextContent("O WhatsApp não confirmou o envio a tempo.");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText(/Confira no WhatsApp do cliente antes de enviar de novo/)).toBeInTheDocument();
    expect(onReenviar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enviar de novo" }));
    await waitFor(() => expect(onReenviar).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), true));
  });

  it("mensagem de pessoa parada sem conexão diz que NÃO foi enviada, e oferece tentar de novo", () => {
    // Ninguém reenvia a mensagem do atendente quando o número volta (o watchdog
    // só pega a da IA): "Aguardando" seria uma promessa que não se cumpre.
    render(<MessageBubble message={msg({
      status: "queued", sent_via: "user", sent_by_user_id: "eu", updated_at: agora(),
      metadata: { queued_reason: "channel_session_not_working" },
    })} viewerUserId="eu" onReenviar={vi.fn(async () => undefined)} />);
    expect(screen.getByText("Não enviada: sem conexão")).toBeInTheDocument();
    expect(screen.queryByText("Aguardando conexão")).toBeNull();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("parada por falta de conexão da IA diz 'Aguardando conexão'; o envio normal não", () => {
    const { unmount } = render(<MessageBubble message={msg({
      status: "queued", sent_via: "ai", metadata: { queued_reason: "channel_session_not_working" },
    })} />);
    expect(screen.getByText("Aguardando conexão")).toBeInTheDocument();
    unmount();
    render(<MessageBubble message={msg({ status: "queued", metadata: { _optimistic: true }, updated_at: agora() })}
      viewerUserId="eu" onReenviar={vi.fn(async () => undefined)} />);
    expect(screen.queryByText("Aguardando conexão")).toBeNull();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  it("se a rota pede confirmação onde a bolha viu 'nada saiu', a confirmação abre", async () => {
    const onReenviar = vi.fn(async () => {
      throw new ApiError(409, "confirmacao_necessaria", undefined, "r", "Confirme antes de enviar de novo.");
    });
    render(<MessageBubble message={msg({
      status: "failed", error_code: "storage_sign_failed", sent_by_user_id: "eu",
    })} viewerUserId="eu" onReenviar={onReenviar} />);
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText(/Confira no WhatsApp do cliente antes de enviar de novo/)).toBeInTheDocument();
    expect(onReenviar).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), false);
  });

  it("mensagem da IA que falhou mostra o motivo e não tem botão", () => {
    render(<MessageBubble message={msg({ status: "failed", error_code: "storage_sign_failed", sent_via: "ai" })}
      viewerUserId="eu" onReenviar={vi.fn(async () => undefined)} podeReenviarDeOutros />);
    expect(screen.getByTestId("motivo-da-falha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  it("sem quem reenvie (leitura do super-admin) não há botão", () => {
    render(<MessageBubble message={msg({ status: "failed", error_code: "storage_sign_failed", sent_by_user_id: "eu" })} viewerUserId="eu" />);
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });
});
