import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ITEM 29 DA AUDITORIA DE 17/11: QUEM SAI DIGITANDO ESCREVE, NÃO DISPARA ATALHO.
 *
 * Ao abrir uma conversa o cursor não ia para o campo, e os atalhos de uma letra
 * valiam com o foco em qualquer lugar fora de um campo: "a" assumia a conversa,
 * "e" abria "Fechar conversa" com o botão da ação já focado, e o espaço seguinte
 * confirmava. Aqui o Inbox é montado com os atalhos e a confirmação DE VERDADE.
 */

const { ORG, CONV_A, CONV_B, linha } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000029aa";
  const CONV_A = "00000000-0000-4000-8000-0000000029a1";
  const CONV_B = "00000000-0000-4000-8000-0000000029b1";
  const linha = (id: string, nome: string) => ({
    id,
    organization_id: ORG,
    contact_id: `${id.slice(0, -2)}c1`,
    status: "open",
    tags: [],
    channel_sessions: { provider: "waha" },
    contacts: { id: `${id.slice(0, -2)}c1`, display_name: nome, name: null, phone_number: "+5527999990000", tags: [] },
  });
  return { ORG, CONV_A, CONV_B, linha };
});

vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({ useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(), patch: vi.fn() },
}));
const LISTA = {
  data: { pages: [{ data: [linha(CONV_A, "Ana Fictícia"), linha(CONV_B, "Bruno Fictício")] }] },
  realtimeStatus: "ok",
};
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: () => LISTA }));
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
const assumir = vi.fn();
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: assumir, isPending: false }),
}));
const fechar = vi.fn();
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: fechar, isPending: false }),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({
    onSelect,
    onVisibleChange,
  }: {
    onSelect: (id: string) => void;
    onVisibleChange?: (ids: string[]) => void;
  }) => {
    useEffect(() => onVisibleChange?.([CONV_A, CONV_B]), [onVisibleChange]);
    return (
      <>
        <button onClick={() => onSelect(CONV_A)}>Abrir A</button>
        <button onClick={() => onSelect(CONV_B)}>Abrir B</button>
      </>
    );
  },
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({
  ChatThread: ({ conversationId }: { conversationId: string }) => <div data-testid="fio" data-conversa={conversationId} />,
}));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar(inicial: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={inicial} />
    </QueryClientProvider>,
  );
}

const CODIGO: Record<string, string> = { a: "KeyA", e: "KeyE", j: "KeyJ", k: "KeyK", r: "KeyR" };
function tecla(letra: string) {
  const alvo = document.activeElement ?? document.body;
  fireEvent.keyDown(alvo, { key: letra, code: CODIGO[letra] });
  fireEvent.keyUp(alvo, { key: letra, code: CODIGO[letra] });
}
const campo = () => screen.getByRole("textbox", { name: "Mensagem" });

describe("item 29 — atalho de uma letra só com o cursor na lista", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app/inbox");
    assumir.mockClear();
    fechar.mockClear();
    // Computador: mouse e hover.
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("hover: hover") || q.includes("pointer: fine"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("⭐ abrir pela lista põe o cursor no campo, e o 'a' digitado não assume", () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    expect(campo()).toHaveFocus();
    tecla("a");
    expect(assumir).not.toHaveBeenCalled();
  });

  it("com o foco fora da lista (no corpo da página), 'a' e 'e' não fazem nada", () => {
    montar(CONV_A);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    tecla("a");
    tecla("e");
    expect(assumir).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("com o foco na lista, 'a' assume e 'e' pergunta — com o foco no Cancelar", () => {
    montar(CONV_A);
    act(() => screen.getByRole("button", { name: "Abrir A" }).focus());
    tecla("a");
    expect(assumir).toHaveBeenCalledTimes(1);

    tecla("e");
    const dialogo = screen.getByRole("alertdialog");
    expect(dialogo).toHaveTextContent("Fechar esta conversa?");
    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
    // O Enter (ou espaço) seguinte cai no Cancelar: nada fecha.
    fireEvent.click(document.activeElement as HTMLElement);
    expect(fechar).not.toHaveBeenCalled();
  });

  it("j pela lista abre a próxima e o foco FICA na lista, para o próximo j", () => {
    montar(CONV_A);
    const botaoA = screen.getByRole("button", { name: "Abrir A" });
    act(() => botaoA.focus());
    tecla("j");
    expect(screen.getByTestId("fio")).toHaveAttribute("data-conversa", CONV_B);
    expect(campo()).not.toHaveFocus();
    expect(botaoA).toHaveFocus();
  });
});
