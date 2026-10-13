/**
 * A faixa de abas do Inbox QUEBRA em vez de esconder (porte do upstream
 * melgarafael/DeskcommCRM#2766, adaptado às abas deste fork: Fila, Minhas,
 * Todas e o menu "Mais").
 *
 * O jsdom não calcula layout, então isto é só a catraca barata: a classe que
 * faz a quebra. A medida foi tirada em browser real com o CSS compilado, e
 * está no comentário da faixa em `components/inbox/InboxFilters.tsx`: sem o
 * `flex-wrap`, a `TabsList` (que tem `overflow-x-auto`) rolava para o lado e o
 * "Mais" ficava cortado na coluna de 240 a 272px.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", name: "Org", role: "admin", visibility_mode: "all" } }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  channelLabel: (c: { display_name: string }) => c.display_name,
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({ useConversationTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { fila: 47, automatico: 267, mine: 8, all: 130, closed: 25, archived: 9 } }),
}));

const VALUE: InboxFiltersValue = { tab: "ai", search: "", onlyUnread: false };

afterEach(cleanup);

describe("faixa de abas do Inbox: quebra em vez de esconder", () => {
  it("a faixa tem `flex-wrap`: sem ele ela rola para o lado e o \"Mais\" fica cortado", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tablist").className.split(/\s+/)).toContain("flex-wrap");
  });

  it("as três abas de trabalho e o menu \"Mais\" estão na faixa, com o rótulo inteiro", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // Guarda do outro lado: a saída fácil para "não cabe" é tirar aba ou encurtar rótulo.
    expect(screen.getAllByRole("tab").map((a) => a.textContent?.replace(/\s+/g, ""))).toEqual([
      "Fila47",
      "Minhas8",
      "Todas130",
    ]);
    // Com uma aba do "Mais" ativa, o gatilho mostra o nome e a contagem dela.
    expect(screen.getByRole("button", { name: "Mais abas" }).textContent).toContain("Automático");
    expect(screen.getByRole("button", { name: "Mais abas" }).textContent).toContain("267");
  });
});
