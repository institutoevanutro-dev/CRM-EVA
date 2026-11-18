import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Item 36 da auditoria de 17/11: abaixo de 1280px a coluna do contato fica
 * escondida pelo CSS, e mesmo assim o painel montava — buscando ficha, tarefas
 * e equipe a cada conversa e gravando na auditoria que a ficha foi aberta.
 * Agora ele só monta quando a coluna aparece.
 */

const { ORG, CONV } = vi.hoisted(() => ({
  ORG: "00000000-0000-4000-8000-0000000036aa",
  CONV: "00000000-0000-4000-8000-0000000036a1",
}));
const LISTA = {
  data: { pages: [{ data: [{ id: CONV, organization_id: ORG, status: "open", tags: [], contacts: null }] }] },
  realtimeStatus: "ok",
};
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: () => LISTA }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(async () => ({ data: [] })) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG, role: "admin" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => <aside data-testid="painel-do-contato" /> }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montarEm(largura: number) {
  Object.defineProperty(window, "innerWidth", { value: largura, configurable: true, writable: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONV} />
    </QueryClientProvider>,
  );
}

describe("item 36 — o painel do contato escondido não carrega", () => {
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  });

  it("⭐ a 1000px (coluna escondida) o painel não monta", () => {
    montarEm(1000);
    expect(screen.queryByTestId("painel-do-contato")).toBeNull();
  });

  it("a 1440px (coluna à vista) o painel monta", () => {
    montarEm(1440);
    expect(screen.getByTestId("painel-do-contato")).toBeInTheDocument();
  });
});
