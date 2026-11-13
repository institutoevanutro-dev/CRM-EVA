// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "./_client";

const mutate = vi.fn();
let role = "manager";
let ligado = true;

vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: { data: { id: "c1", tags: [], is_blocked: false, is_anonymized: false, phone_number: "+5541999953255", custom_fields: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", prontuario_linked: ligado } },
  }),
}));
vi.mock("@/hooks/contacts/useUnblockContact", () => ({ useUnblockContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/useReiniciarTeste", () => ({ useReiniciarTeste: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/useDesvincularDoProntuario", () => ({ useDesvincularDoProntuario: () => ({ mutate, isPending: false }) }));
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

describe("Desvincular do Prontuário na ficha do contato", () => {
  beforeEach(() => {
    mutate.mockClear();
    ligado = true;
  });

  it("manager vê a linha do vínculo; confirmar chama o hook", () => {
    role = "manager";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.getByTestId("vinculo-prontuario").textContent).toContain("Ficha vinculada");
    fireEvent.click(screen.getByRole("button", { name: "Desvincular do Prontuário" }));
    expect(screen.getByText(/Nada é apagado no Prontuário/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Desvincular" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("agent vê o vínculo, mas não o botão", () => {
    role = "agent";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.getByTestId("vinculo-prontuario")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Desvincular do Prontuário" })).toBeNull();
  });

  it("sem vínculo, a linha não aparece", () => {
    ligado = false;
    role = "admin";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.queryByTestId("vinculo-prontuario")).toBeNull();
  });
});
