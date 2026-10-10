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
    data: { data: { id: "c1", tags: [], is_blocked: false, is_anonymized: false, phone_number: "+5541999953255", custom_fields: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } },
  }),
}));
vi.mock("@/hooks/contacts/useUnblockContact", () => ({ useUnblockContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/useReiniciarTeste", () => ({ useReiniciarTeste: () => ({ mutate, isPending: false }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false }, activeOrg: { role } }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
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

describe("botão Reiniciar teste", () => {
  beforeEach(() => mutate.mockClear());

  it("aparece para manager e confirmar chama o hook", () => {
    role = "manager";
    render(<ContactDetailClient contactId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar teste" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Reiniciar teste" }).at(-1)!);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("some para agent", () => {
    role = "agent";
    render(<ContactDetailClient contactId="c1" />);
    expect(screen.queryByRole("button", { name: "Reiniciar teste" })).toBeNull();
  });
});
