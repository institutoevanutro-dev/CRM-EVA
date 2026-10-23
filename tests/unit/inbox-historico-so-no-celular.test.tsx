import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O VOLTAR DO CELULAR, MONTADO (porte do original #3190, adaptado ao fork).
 *
 * No original a seleção já vivia na URL em qualquer largura. Neste fork ela
 * era só estado da tela, e o porte a põe no histórico SÓ abaixo do `md`, onde
 * lista e conversa são telas separadas: no computador o voltar do navegador
 * continua sem passear pelas conversas clicadas. Estes casos prendem os dois
 * lados, e o elo da URL de volta para a tela (o `popstate` devolve a lista).
 */

const { ORG, CONV_A, linha } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000005aa";
  const CONV_A = "00000000-0000-4000-8000-0000000005a1";
  const linha = (id: string) => ({
    id,
    organization_id: ORG,
    contact_id: `${id.slice(0, -2)}c1`,
    status: "open",
    tags: [],
    contacts: { id: `${id.slice(0, -2)}c1`, display_name: "Contato Fictício", name: null, phone_number: "+5511900000000", tags: [] },
  });
  return { ORG, CONV_A, linha };
});

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) return new Promise(() => {});
  if (url === `/api/v1/conversations/${CONV_A}`) return { data: linha(CONV_A) };
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
const LISTA = { data: { pages: [{ data: [linha(CONV_A)] }] }, realtimeStatus: "ok" };
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: () => LISTA }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
// Como o Next: o `useSearchParams` reflete a URL a cada render.
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/app/actions/inbox/togglePainelDoContato", () => ({ togglePainelDoContato: vi.fn(async () => undefined) }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button onClick={() => onSelect(CONV_A)}>Abrir A</button>
  ),
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({
  ChatThread: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="fio" data-conversa={conversationId} />
  ),
}));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

/** Celular = a consulta `max-width` do `max-md:` casa. Ponteiro grosso fica falso. */
function larguraDeCelular(celular: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: celular && q.includes("max-width"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

function montar(inicial: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={inicial} />
    </QueryClientProvider>
  );
  const r = render(arvore());
  // Re-renderizar depois de mudar a URL é o que o Next faz no `popstate`.
  return { renderDeNovo: () => r.rerender(arvore()) };
}

const voltar = () => screen.getByRole("button", { name: "Conversas" });

beforeEach(() => {
  window.history.replaceState(null, "", "/app/inbox");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("o voltar do Inbox no celular", () => {
  it("abrir pela lista empilha `?id=` com a marca; voltar anda para trás e a URL devolve a lista", () => {
    larguraDeCelular(true);
    const empilhar = vi.spyOn(window.history, "pushState");
    // O `go` real do jsdom é assíncrono; aqui ele faz o que o navegador faria:
    // volta à entrada da lista.
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {
      window.history.replaceState(null, "", "/app/inbox");
    });
    const { renderDeNovo } = montar();

    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    expect(empilhar).toHaveBeenCalledWith({ inboxProfundidade: 1 }, "", `/app/inbox?id=${CONV_A}`);
    expect(window.location.search).toBe(`?id=${CONV_A}`);
    expect(screen.getByTestId("fio")).toHaveAttribute("data-conversa", CONV_A);

    fireEvent.click(voltar());
    expect(go).toHaveBeenCalledWith(-1);
    // Quem troca é a URL (o `popstate`), não o clique.
    renderDeNovo();
    expect(screen.queryByTestId("fio")).toBeNull();
    expect(screen.getByText("Selecione uma conversa")).toBeInTheDocument();
  });

  it("link direto (sem marca): voltar troca a entrada no lugar e não mexe na pilha", () => {
    larguraDeCelular(true);
    window.history.replaceState(null, "", `/app/inbox?id=${CONV_A}`);
    const go = vi.spyOn(window.history, "go");
    const empilhar = vi.spyOn(window.history, "pushState");
    const antes = window.history.length;
    montar(CONV_A);
    expect(screen.getByTestId("fio")).toHaveAttribute("data-conversa", CONV_A);

    fireEvent.click(voltar());
    expect(go).not.toHaveBeenCalled();
    expect(empilhar).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(window.history.length).toBe(antes);
    expect(screen.queryByTestId("fio")).toBeNull();
  });
});

describe("no computador nada muda", () => {
  it("clicar na lista e voltar não tocam o histórico nem a URL", () => {
    larguraDeCelular(false);
    const empilhar = vi.spyOn(window.history, "pushState");
    const trocar = vi.spyOn(window.history, "replaceState");
    const go = vi.spyOn(window.history, "go");
    montar();

    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    expect(screen.getByTestId("fio")).toHaveAttribute("data-conversa", CONV_A);
    fireEvent.click(voltar());
    expect(screen.queryByTestId("fio")).toBeNull();

    expect(empilhar).not.toHaveBeenCalled();
    expect(trocar).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
});
