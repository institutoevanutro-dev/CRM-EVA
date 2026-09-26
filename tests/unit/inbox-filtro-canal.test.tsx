/**
 * Task 8 — comportamento do Select no InboxFilters: "Só Instagram" e "Só
 * WhatsApp" mandam `canal` e limpam `channel_session_id`; escolher um número
 * específico limpa `canal`; "Todos os números" limpa os dois.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = {
  current: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" },
};
const canaisRef: { current: ChannelSession[] | undefined } = { current: [] };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: canaisRef.current }) };
});
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { unassigned: 3, mine: 2, all: 5 } }),
}));

function canal(over: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id: "canal-1",
    waha_session_name: "org_1111_aaa",
    display_name: "Vendas",
    phone_number: "5511999999999",
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 250,
    is_warmup_complete: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };
const SELETOR = "Filtrar por número de WhatsApp";

beforeEach(() => {
  canaisRef.current = [canal(), canal({ id: "canal-2", display_name: "Suporte" })];
});
afterEach(cleanup);

describe("InboxFilters — filtro Só Instagram / Só WhatsApp", () => {
  it("escolher 'Só Instagram' manda canal=instagram e limpa channel_session_id", () => {
    const onChange = vi.fn();
    render(
      <InboxFilters
        value={{ ...VALUE, channel_session_id: "canal-1" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText(SELETOR));
    fireEvent.click(screen.getByRole("option", { name: "Só Instagram" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ canal: "instagram", channel_session_id: undefined }),
    );
  });

  it("escolher 'Só WhatsApp' manda canal=whatsapp e limpa channel_session_id", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(SELETOR));
    fireEvent.click(screen.getByRole("option", { name: "Só WhatsApp" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ canal: "whatsapp", channel_session_id: undefined }),
    );
  });

  it("escolher um número específico limpa canal", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={{ ...VALUE, canal: "instagram" }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(SELETOR));
    fireEvent.click(screen.getByRole("option", { name: "Suporte" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ channel_session_id: "canal-2", canal: undefined }),
    );
  });

  it("'Todos os números' limpa canal e channel_session_id", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={{ ...VALUE, canal: "whatsapp" }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(SELETOR));
    fireEvent.click(screen.getByRole("option", { name: "Todos os números" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ channel_session_id: undefined, canal: undefined }),
    );
  });
});
