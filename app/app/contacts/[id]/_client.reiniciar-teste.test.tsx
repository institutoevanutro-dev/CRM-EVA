// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "./_client";

const mutate = vi.fn();
let role = "manager";

vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: { data: { id: "c1", tags: [], is_blocked: false, is_anonymized: false, phone_number: "+5541999953255", custom_fields: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
      conversa: { id: "v1", preview: null, last_message_at: null, unread: 2 },
      consultas: [
        { id: "a1", title: "Avaliação", starts_at: "2099-01-10T13:00:00Z", status: "confirmed" },
        { id: "a2", title: "Retorno", starts_at: "2020-01-10T13:00:00Z", status: "no_show" },
      ] } },
  }),
}));
vi.mock("@/hooks/contacts/useUnblockContact", () => ({ useUnblockContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/useReiniciarTeste", () => ({ useReiniciarTeste: () => ({ mutate, isPending: false }) }));
vi.mock("@/hooks/contacts/useDesvincularDoProntuario", () => ({ useDesvincularDoProntuario: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/useAlwaysHumanContact", () => ({ useAlwaysHumanContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/useOcultarDoInbox", () => ({ useOcultarDoInbox: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false }, activeOrg: { role } }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
// O autocompletar de etiquetas da ficha (#2732) lê o vocabulário da organização.
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/lib/leads/campos-do-funil", () => ({ camposDoFunil: () => [] }));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/contacts/CanaisDoContato", () => ({ CanaisDoContato: () => null }));
vi.mock("@/components/contacts/CpfDoContato", () => ({ CpfDoContato: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));
vi.mock("@/components/contacts/FinanceiroDoContato", () => ({ FinanceiroDoContato: () => null }));
// "Juntar com outra ficha" (porte do #3640) usa o roteador e o react-query; aqui ele não é o assunto.
vi.mock("@/components/contacts/JuntarComOutraFicha", () => ({ JuntarComOutraFicha: () => null }));

describe("botão Reiniciar teste", () => {
  beforeEach(() => mutate.mockClear());

  it("aparece para manager, no menu Mais, e confirmar chama o hook", () => {
    role = "manager";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.queryByRole("button", { name: "Reiniciar teste" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mais" }));
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar teste" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Reiniciar teste" }).at(-1)!);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("some para agent", () => {
    role = "agent";
    render(<ContactDetailClient contactId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Mais" }));
    expect(screen.queryByRole("button", { name: "Reiniciar teste" })).toBeNull();
  });
});

describe("ação principal e consultas no topo (item 140)", () => {
  it("Marcar consulta é o link principal e leva o contato e a conversa à Agenda", () => {
    role = "agent";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.getByRole("link", { name: "Marcar consulta" })).toHaveAttribute(
      "href",
      "/app/agenda?contato=c1&conversa=v1",
    );
    expect(screen.getByRole("link", { name: /Conversar/ })).toHaveAttribute("href", "/app/inbox?id=v1");
  });

  it("viewer não ganha o Marcar consulta", () => {
    role = "viewer";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.queryByRole("link", { name: "Marcar consulta" })).toBeNull();
  });

  it("mostra próximas e últimas, cada uma abrindo o compromisso", () => {
    role = "agent";
    render(<ContactDetailClient contactId="c1" />);
    const bloco = screen.getByTestId("consultas-do-contato");
    expect(bloco).toHaveTextContent("Próximas");
    expect(bloco).toHaveTextContent("Avaliação");
    expect(bloco).toHaveTextContent("Últimas");
    expect(bloco).toHaveTextContent("Não compareceu");
    expect(screen.getByRole("link", { name: /Avaliação/ })).toHaveAttribute("href", "/app/agenda?compromisso=a1");
  });
});
