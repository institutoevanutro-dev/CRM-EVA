/**
 * A faixa de abas do Inbox NUNCA ESCONDE aba (porte do upstream
 * melgarafael/DeskcommCRM#2766, adaptado às abas deste fork: Fila, Minhas,
 * Todas e o menu "Mais").
 *
 * Até 16/11/2026 a garantia era a QUEBRA de linha (`flex-wrap`). Com o visual
 * de app de mensagem, abas e filtros passaram a uma linha só que ROLA para o
 * lado (comentário da faixa em `components/inbox/InboxFilters.tsx`): o defeito
 * que a quebra evitava era a faixa cortar o "Mais" sem ter para onde rolar.
 * O jsdom não calcula layout, então isto é a catraca barata: a faixa declara a
 * rolagem, as abas não quebram, e abas e filtros moram na MESMA faixa.
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

describe("faixa de abas do Inbox: uma linha que rola, nunca aba escondida", () => {
  it("abas e filtros numa faixa só, que declara a rolagem lateral", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    const abas = screen.getByRole("tablist");
    expect(abas.className.split(/\s+/)).toContain("flex-nowrap");
    const faixa = abas.closest("[data-faixa-de-filtros]");
    expect(faixa, "as abas saíram da faixa que rola").not.toBeNull();
    expect(faixa!.className.split(/\s+/)).toContain("overflow-x-auto");
    // O filtro de não lidos mora na MESMA linha: uma segunda faixa seria a lista carregada de volta.
    expect(faixa!.contains(screen.getByRole("button", { name: "Não lidos" }))).toBe(true);
  });

  it("as três abas de trabalho e o menu \"Mais\" estão na faixa, com o rótulo inteiro", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // Guarda do outro lado: a saída fácil para "não cabe" é tirar aba ou encurtar rótulo.
    expect(screen.getAllByRole("tab").map((a) => a.textContent?.replace(/\s+/g, ""))).toEqual([
      "Fila47",
      "Minhas8",
      "Todas130",
    ]);
    // Com uma aba do "Mais" ativa, o gatilho mostra o nome e a contagem dela — e
    // é esse nome que o leitor de tela anuncia, não "Mais abas" (item 215).
    const gatilho = screen.getByRole("button", { name: /^Automático/ });
    expect(gatilho.textContent).toContain("267");
    expect(screen.queryByRole("button", { name: "Mais abas" })).toBeNull();
  });
});
