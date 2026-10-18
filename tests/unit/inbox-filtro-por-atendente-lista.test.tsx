import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O atendente escolhido no seletor chega à LISTA, não só às contagens.
 *
 * O seletor mora em `InboxFilters`; quem monta a consulta da lista é o
 * `InboxLayout`. Este arquivo prova o elo entre os dois: escolhido o atendente,
 * a lista pede `assigned_to=<id>` à rota — e na aba Minhas o `me` da aba vence.
 *
 * Portado do projeto original (DeskcommCRM, PR #2982 de @wellpelomundo).
 */
const { ORG, ATENDENTE, aba } = vi.hoisted(() => ({
  ORG: "00000000-0000-4000-8000-0000000000aa",
  ATENDENTE: "bf49a9c8-9fbd-448c-8a94-4db4b14b7219",
  aba: { atual: "all" },
}));

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) return { data: [], meta: { has_more: false, cursor: null } };
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ filter: aba.atual }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "manager" }, activeOrg: { orgId: ORG, role: "manager" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
// A barra de filtros vira um botão que faz o que o seletor faz: escolhe o atendente.
vi.mock("@/components/inbox/InboxFilters", () => ({
  InboxFilters: ({
    value,
    onChange,
  }: {
    value: Record<string, unknown>;
    onChange: (v: Record<string, unknown>) => void;
  }) => (
    <button type="button" onClick={() => onChange({ ...value, assigned_to: ATENDENTE })}>
      escolher atendente
    </button>
  ),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>,
  );
}

const pedidosDaLista = () =>
  get.mock.calls.map((c) => c[0] ?? "").filter((u) => u.startsWith("/api/v1/conversations?"));

describe("filtro por atendente — a lista pede o atendente escolhido", () => {
  beforeEach(() => get.mockClear());

  it("em Todas, escolher o atendente faz a lista pedir assigned_to=<id>", async () => {
    aba.atual = "all";
    montar();
    fireEvent.click(screen.getByRole("button", { name: "escolher atendente" }));
    await waitFor(() =>
      expect(pedidosDaLista().some((u) => u.includes(`assigned_to=${ATENDENTE}`))).toBe(true),
    );
  });

  it("em Minhas, o `me` da aba vence a escolha", async () => {
    aba.atual = "mine";
    montar();
    fireEvent.click(screen.getByRole("button", { name: "escolher atendente" }));
    await waitFor(() => expect(pedidosDaLista().length).toBeGreaterThan(0));
    expect(pedidosDaLista().every((u) => u.includes("assigned_to=me"))).toBe(true);
    expect(pedidosDaLista().some((u) => u.includes(ATENDENTE))).toBe(false);
  });
});
