import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));

import type { Message } from "@/lib/types/messaging";

import { ExameNoProntuario } from "./ExameNoProntuario";

afterEach(cleanup);

const AGORA = Date.parse("2026-11-04T12:00:00.000Z");
const ID = "11111111-1111-4111-8111-111111111111";
function msg(p: Partial<Message> = {}): Message {
  return {
    id: ID, organization_id: "o", conversation_id: "c", channel_session_id: "s", contact_id: "k", external_id: null,
    type: "document", direction: "inbound", status: "received", ack: null, error_code: null, error_message: null,
    body: null, media_url: null, media_mime: "application/pdf", media_size_bytes: 1000, media_storage_path: `o/c/${ID}.pdf`,
    sent_via: "external_device", sent_by_user_id: null, sent_at: new Date(AGORA - 3600_000).toISOString(),
    delivered_at: null, read_at: null, metadata: {}, edited_at: null, revoked_at: null, reply_to_message_id: null,
    created_at: new Date(AGORA).toISOString(), ...p,
  };
}
const selo = (ja_existia = false) => ({ ja_existia, enviado_em: "2026-11-04T10:30:00.000Z", enviado_por_user_id: "u" });

describe("ExameNoProntuario", () => {
  it("sem onEnviar: nada (nem botão, nem dica)", () => {
    const { container } = render(<ExameNoProntuario message={msg()} agora={AGORA} />);
    expect(container).toBeEmptyDOMElement();
    const heic = render(<ExameNoProntuario message={msg({ media_mime: "image/heic" })} agora={AGORA} />);
    expect(heic.container).toBeEmptyDOMElement();
  });

  it("selo para quem não pode enviar, com quem e quando VISÍVEIS", () => {
    render(<ExameNoProntuario message={msg({ prontuario_exame: selo() })} agora={AGORA} quemEnviou="Atendente Fictícia" />);
    expect(screen.getByText("No prontuário")).toBeVisible();
    expect(screen.getByText(/^por Atendente Fictícia · /)).toBeVisible();
    expect(screen.getByTestId("selo-do-prontuario")).toHaveAttribute("title", expect.stringMatching(/^Enviado ao prontuário por Atendente Fictícia em /));
    expect(screen.queryByTestId("enviar-ao-prontuario")).toBeNull();
  });

  it("selo de exame que já estava lá não atribui o envio", () => {
    render(<ExameNoProntuario message={msg({ prontuario_exame: selo(true) })} agora={AGORA} quemEnviou="Atendente Fictícia" onEnviar={vi.fn()} />);
    expect(screen.getByText(/^já estava lá · conferido por Atendente Fictícia · /)).toBeVisible();
    expect(screen.queryByText(/^por Atendente/)).toBeNull();
  });

  it("botão chama onEnviar com a mensagem", () => {
    const onEnviar = vi.fn();
    render(<ExameNoProntuario message={msg()} agora={AGORA} onEnviar={onEnviar} />);
    fireEvent.click(screen.getByTestId("enviar-ao-prontuario"));
    expect(onEnviar).toHaveBeenCalledWith(expect.objectContaining({ id: ID }));
  });

  it("enviando: aria-busy e desabilitado", () => {
    render(<ExameNoProntuario message={msg()} agora={AGORA} onEnviar={vi.fn()} enviando />);
    const b = screen.getByRole("button", { name: /Enviando…/ });
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).toBeDisabled();
  });

  it("erro visível embaixo do botão", () => {
    render(<ExameNoProntuario message={msg()} agora={AGORA} onEnviar={vi.fn()} erro="Frase do erro fictícia." />);
    expect(screen.getByTestId("erro-ao-prontuario")).toHaveTextContent("Frase do erro fictícia.");
    expect(screen.getByTestId("enviar-ao-prontuario")).toBeVisible();
  });

  it("dicas: formato, grande e falhou", () => {
    render(<ExameNoProntuario message={msg({ media_mime: "image/heic" })} agora={AGORA} onEnviar={vi.fn()} />);
    expect(screen.getByText("Peça ao paciente um PDF ou foto comum")).toBeVisible();
    cleanup();
    render(<ExameNoProntuario message={msg({ media_size_bytes: 11 * 1024 * 1024 })} agora={AGORA} onEnviar={vi.fn()} />);
    expect(screen.getByText("Arquivo maior que 10 MB: peça ao paciente um arquivo menor")).toBeVisible();
    cleanup();
    render(<ExameNoProntuario message={msg({ media_storage_path: null, metadata: { media_status: "failed" } })} agora={AGORA} onEnviar={vi.fn()} />);
    expect(screen.getByText("O arquivo não chegou inteiro ao CRM. Peça ao paciente para enviar de novo.")).toBeVisible();
    expect(screen.queryByTestId("enviar-ao-prontuario")).toBeNull();
  });
});
