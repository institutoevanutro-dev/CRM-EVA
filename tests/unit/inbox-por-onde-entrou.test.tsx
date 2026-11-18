import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * A LINHA DA LISTA É A DE APP DE MENSAGEM (pedido do André, 18/11/2026).
 *
 * Foto (com o selo do canal no canto: WhatsApp ou Instagram), nome ou número,
 * hora à direita, prévia com o tique quando a última mensagem foi nossa, e a
 * bolinha de não lidas. Os selos de etapa, etiqueta, situação e NÚMERO DA
 * EMPRESA por onde a conversa entrou saíram da linha: moram no painel do
 * contato, no menu ⋯ da conversa e nos filtros (o filtro por número continua).
 *
 * Este arquivo substitui o "por onde entrou", que provava o selo do número na
 * linha. O que continua valendo dele: o canal se anuncia (o selo da foto) e o
 * SELECT da lista traz a sessão — o filtro por número e o menu dependem dela.
 */
import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const agora = Date.now();
const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "open",
  assigned_to_user_id: "u-2",
  assigned_to_user_name: "Bruna Fictícia",
  assignee_kind: "user",
  etapa_atual: "Avaliação marcada",
  last_message_at: new Date(agora).toISOString(),
  last_inbound_at: new Date(agora - 60_000).toISOString(),
  last_outbound_at: null,
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: new Date(agora).toISOString(),
  channel_sessions: { phone_number: "+5527999990000", display_name: "Recepção", provider: "waha" },
  contacts: {
    id: "ct1", display_name: "Paciente Fictícia", name: null, phone_number: "+5527988887777",
    tags: ["vip", "retorno"], is_blocked: false, is_anonymized: false,
  },
} as unknown as ConversationWithContact;

const pintar = (extra: Record<string, unknown> = {}) =>
  render(
    <ConversationListItem
      conversation={{ ...base, ...extra } as ConversationWithContact}
      isSelected={false}
      onSelect={() => {}}
    />,
  );

describe("linha de app de mensagem", () => {
  it("⭐ foto, nome, hora e prévia — sem selo de etapa, etiqueta, situação ou número do canal", () => {
    const { container } = pintar();
    expect(screen.getByText("Paciente Fictícia")).toBeTruthy();
    expect(screen.getByText("olá")).toBeTruthy();
    expect(screen.getByRole("img", { name: "WhatsApp" })).toBeTruthy();
    for (const fora of ["Avaliação marcada", "vip", "retorno", "Recepção", "Bruna Fictícia", "Equipe"]) {
      expect(screen.queryByText(fora), fora).toBeNull();
    }
    expect(container.textContent).not.toContain("+5527999990000");
    expect(container.querySelector("[data-etapa-da-conversa], [data-selo-do-comando]")).toBeNull();
  });

  it("Instagram: o selo da foto diz o canal", () => {
    pintar({ channel: "instagram" });
    expect(screen.getByRole("img", { name: "Instagram" })).toBeTruthy();
  });

  it("o tique aparece quando a última mensagem foi nossa — e só então", () => {
    const { unmount } = pintar({ last_outbound_at: new Date(agora).toISOString() });
    expect(screen.getByLabelText("Sua mensagem")).toBeTruthy();
    unmount();
    pintar();
    expect(screen.queryByLabelText("Sua mensagem")).toBeNull();
  });

  it("a bolinha de não lidas diz quantas, também para o leitor de tela", () => {
    pintar({ unread_count_for_assignee: 3 });
    expect(screen.getByLabelText("3 não lidas").textContent).toBe("3");
  });

  it("na Fila a posição e a espera continuam: é a régua por que ela é ordenada", () => {
    render(<ConversationListItem conversation={base} isSelected={false} onSelect={() => {}} queuePosition={1} />);
    expect(screen.getByText("1º")).toBeTruthy();
    expect(screen.getByText(/^Aguardando/)).toBeTruthy();
  });
});

describe("o elo que some sem barulho", () => {
  it("o SELECT do listado traz a sessão — o filtro por número e o menu dependem dela", () => {
    const fonte = readFileSync("app/api/v1/conversations/_handler.ts", "utf8");
    expect(fonte, "falta o embed da sessão no SELECT_COLS").toMatch(
      /channel_sessions:channel_session_id\s*\([^)]*phone_number/,
    );
  });
});
