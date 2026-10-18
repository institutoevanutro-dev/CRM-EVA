/**
 * Filtro por atendente no Inbox — quem vê o seletor, e entrar em Minhas limpa a
 * escolha.
 *
 * O seletor é de GERENTE para cima: a lista da equipe é da gestão, e o atendente
 * comum continua vendo só o que a visibilidade da organização deixa. Na aba
 * Minhas ele some, porque ela já é "só as minhas" — e seguir com a escolha ali
 * deixaria as outras abas contando o atendente com o seletor escondido.
 *
 * Portado do projeto original (DeskcommCRM, PR #2982 de @wellpelomundo); lá o
 * caminho a vigiar eram as setas de aba, aqui é a faixa de abas.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const ATENDENTE = "bf49a9c8-9fbd-448c-8a94-4db4b14b7219";
const activeOrgRef: { current: ActiveOrg | null } = { current: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: {} }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [{ user_id: ATENDENTE, role: "agent", full_name: "Atendente Fictícia" }] }),
}));

function comConsultas(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const COM_ATENDENTE: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false, assigned_to: ATENDENTE };
const SELETOR = "Filtrar por atendente";

beforeEach(() => {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
});
afterEach(cleanup);

describe("filtro por atendente — quem vê o seletor", () => {
  it("gerente vê o seletor ao lado dos outros filtros", () => {
    comConsultas(<InboxFilters value={{ ...COM_ATENDENTE, assigned_to: undefined }} onChange={() => {}} />);
    expect(screen.getByLabelText(SELETOR)).toBeInTheDocument();
  });

  it("atendente comum e leitor NÃO veem o seletor", () => {
    for (const role of ["agent", "viewer"] as const) {
      activeOrgRef.current = { orgId: "org-1", name: "Org", role, visibility_mode: "all" };
      comConsultas(<InboxFilters value={{ ...COM_ATENDENTE, assigned_to: undefined }} onChange={() => {}} />);
      expect(screen.queryByLabelText(SELETOR), role).toBeNull();
      cleanup();
    }
  });

  it("na aba Minhas o seletor some", () => {
    comConsultas(<InboxFilters value={{ ...COM_ATENDENTE, tab: "mine" }} onChange={() => {}} />);
    expect(screen.queryByLabelText(SELETOR)).toBeNull();
  });
});

describe("filtro por atendente — trocar de aba", () => {
  it("clicar em Minhas limpa o atendente escolhido", () => {
    const onChange = vi.fn();
    comConsultas(<InboxFilters value={COM_ATENDENTE} onChange={onChange} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Minhas/ }), { button: 0 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tab: "mine", assigned_to: undefined }));
  });

  it("CONTROLE: clicar numa aba que não é Minhas mantém a escolha", () => {
    const onChange = vi.fn();
    comConsultas(<InboxFilters value={COM_ATENDENTE} onChange={onChange} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Fila/ }), { button: 0 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tab: "unassigned", assigned_to: ATENDENTE }));
  });
});
