import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ITEM 32 DA AUDITORIA DE 17/11: A SELEÇÃO É DA LISTA QUE ESTÁ NA TELA.
 *
 * Marcar três conversas na Fila, trocar para "Minhas" e apertar "Fechar"
 * fechava as três que ninguém via mais. E o "Selecionar todas" não desmarcava
 * no segundo clique.
 */

const { ORG, A, B } = vi.hoisted(() => ({
  ORG: "00000000-0000-4000-8000-0000000032aa",
  A: "00000000-0000-4000-8000-0000000032a1",
  B: "00000000-0000-4000-8000-0000000032b1",
}));

const linha = (id: string) => ({ id, organization_id: ORG, status: "open", tags: [], contacts: null });
const LISTA = { data: { pages: [{ data: [linha(A), linha(B)] }] }, realtimeStatus: "ok" };
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: () => LISTA }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(async () => ({ data: [] })) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
const replace = vi.fn((url: string) => window.history.replaceState(null, "", url));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG, role: "admin" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
const lote = vi.fn();
vi.mock("@/hooks/inbox/useBulkConversations", () => ({
  useBulkConversations: () => ({ mutate: lote, isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({
  InboxFilters: ({ value, onChange }: { value: { tab: string }; onChange: (v: unknown) => void }) => (
    <button onClick={() => onChange({ ...value, tab: "mine" })}>Ir para Minhas</button>
  ),
}));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({
    selecionados,
    onAlternarSelecao,
    onSelecionarTodosVisiveis,
  }: {
    selecionados?: Set<string>;
    onAlternarSelecao?: (id: string) => void;
    onSelecionarTodosVisiveis?: () => void;
  }) => (
    <>
      <button onClick={() => onAlternarSelecao?.(A)}>Marcar A</button>
      <button onClick={() => onSelecionarTodosVisiveis?.()}>Selecionar todas</button>
      <output data-testid="marcadas">{[...(selecionados ?? [])].sort().join(",")}</output>
    </>
  ),
}));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>
  );
  const r = render(arvore());
  return { renderDeNovo: () => r.rerender(arvore()) };
}

const marcadas = () => screen.getByTestId("marcadas").textContent;

describe("item 32 — a seleção em lote segue a lista na tela", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app/inbox?filter=unassigned");
    lote.mockClear();
  });

  it("⭐ trocar de aba limpa a seleção: a barra some e nada é fechado", () => {
    const tela = montar();
    fireEvent.click(screen.getByRole("button", { name: "Marcar A" }));
    expect(screen.getByTestId("barra-de-acoes-em-lote")).toHaveTextContent("1 conversa selecionada");

    fireEvent.click(screen.getByRole("button", { name: "Ir para Minhas" }));
    tela.renderDeNovo();
    expect(marcadas()).toBe("");
    expect(screen.queryByTestId("barra-de-acoes-em-lote")).toBeNull();
    expect(lote).not.toHaveBeenCalled();
  });

  it("'Selecionar todas' marca as visíveis e o segundo clique desmarca", () => {
    montar();
    const todas = screen.getByRole("button", { name: "Selecionar todas" });
    fireEvent.click(todas);
    expect(marcadas()).toBe([A, B].sort().join(","));
    fireEvent.click(todas);
    expect(marcadas()).toBe("");
  });
});
