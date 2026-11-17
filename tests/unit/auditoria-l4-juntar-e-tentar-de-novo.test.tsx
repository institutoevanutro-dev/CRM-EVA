/**
 * AUDITORIA L4 — achados 35 (Juntar só para quem pode) e 38 (ficha do contato
 * com "Tentar de novo"). Arquivo separado porque os dois mocam o
 * `AuthProvider` de formas diferentes das do outro arquivo do lote. Nomes fictícios.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => getMock(...a), post: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const papel = vi.hoisted(() => ({ role: "agent" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ role: papel.role }),
  useAuth: () => ({ user: { is_platform_admin: false }, activeOrg: { role: papel.role } }),
}));

const refetch = vi.fn();
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ isLoading: false, isError: true, isFetching: false, refetch, data: undefined }),
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/contacts/useUnblockContact", () => ({ useUnblockContact: () => ({}) }));
vi.mock("@/hooks/contacts/useReiniciarTeste", () => ({ useReiniciarTeste: () => ({}) }));
vi.mock("@/hooks/contacts/useDesvincularDoProntuario", () => ({ useDesvincularDoProntuario: () => ({}) }));
vi.mock("@/hooks/contacts/useAlwaysHumanContact", () => ({ useAlwaysHumanContact: () => ({}) }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));

import { MergeDialog } from "@/components/contacts/MergeDialog";
import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

function comProvider(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const contato = (id: string, nome: string) => ({
  id, name: nome, display_name: null, email: null, phone_number: "+5527999990000",
  created_at: "2026-01-01T00:00:00Z", last_activity_at: null,
});

describe("achado 35 — duplicados fortes", () => {
  it("quem não é gestor não vê o Juntar (e sabe a quem pedir)", async () => {
    papel.role = "agent";
    getMock.mockResolvedValue({
      data: [{ chave: "g1", motivos: ["telefone"], principal_sugerido: "a", contatos: [contato("a", "Lia Ramos"), contato("b", "Lia R.")] }],
    });
    comProvider(<MergeDialog open onOpenChange={() => undefined} />);
    expect(await screen.findByText("Peça a um gestor para juntar.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Juntar" })).toBeNull();
  });

  it("gestor continua vendo o Juntar", async () => {
    papel.role = "manager";
    getMock.mockResolvedValue({
      data: [{ chave: "g1", motivos: ["telefone"], principal_sugerido: "a", contatos: [contato("a", "Lia Ramos"), contato("b", "Lia R.")] }],
    });
    comProvider(<MergeDialog open onOpenChange={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Juntar" })).toBeInTheDocument();
  });
});

describe("achado 38 — erro ao carregar a ficha do contato", () => {
  it("oferece Tentar de novo, que recarrega", () => {
    comProvider(<ContactDetailClient contactId="c-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
