/**
 * No Instagram só a equipe responde: a IA nunca escreve ali (a etiqueta
 * HUMAN_AGENT promete gente). O cabeçalho não pode oferecer "Devolver ao
 * automático" nem dizer "Automático volta em instantes" numa conversa em que
 * não existe automático. O WhatsApp segue como antes (controle).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { CHANNEL_PROVIDER_INSTAGRAM, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";

vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: "manager" } }),
}));

function renderHeader(provider: string, channel: string, silencio: string) {
  const conversation = {
    id: "cv-1",
    organization_id: "org-1",
    contact_id: "ct-1",
    status: "open",
    channel,
    assigned_to_user_id: null,
    assignee_kind: null,
    bot_silenced_until: silencio,
    snooze_until: null,
    tags: [],
    last_inbound_at: new Date().toISOString(),
    channel_sessions: { provider },
    contacts: { id: "ct-1", display_name: "Fulana", name: null, phone_number: "5511999" },
  } as unknown as React.ComponentProps<typeof ConversationHeader>["conversation"];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationHeader conversation={conversation} />
    </QueryClientProvider>,
  );
}

const emUmMinuto = () => new Date(Date.now() + 60_000).toISOString();

describe("cabeçalho de conversa do Instagram", () => {
  it("silêncio durável (o que a ingestão grava): sem Devolver ao automático nem selo de automático", () => {
    renderHeader(CHANNEL_PROVIDER_INSTAGRAM, "instagram", "infinity");
    expect(screen.queryByTestId("devolver-ao-automatico")).toBeNull();
    expect(screen.queryByTestId("pausar-o-automatico")).toBeNull();
    expect(screen.queryByTestId("badge-atendimento-humano")).toBeNull();
  });

  it("silêncio curto: nunca diz 'Automático volta em instantes'", () => {
    renderHeader(CHANNEL_PROVIDER_INSTAGRAM, "instagram", emUmMinuto());
    expect(screen.queryByText("Automático volta em instantes")).toBeNull();
    expect(screen.queryByTestId("devolver-ao-automatico")).toBeNull();
  });

  it("controle: no WhatsApp o silêncio curto segue com o selo e a volta", () => {
    renderHeader(CHANNEL_PROVIDER_WAHA, "whatsapp", emUmMinuto());
    expect(screen.getByText("Automático volta em instantes")).toBeTruthy();
    expect(screen.getByTestId("devolver-ao-automatico")).toBeTruthy();
  });
});
