import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ITEM 28 DA AUDITORIA DE 17/11: O CAMPO É DA CONVERSA, NÃO DA TELA.
 *
 * O texto digitado numa conversa ia junto para a próxima aberta — e o áudio em
 * gravação e o modelo da janela de 24 h também. Um Enter mandava a mensagem
 * para o paciente errado. Aqui o Inbox é montado com o campo DE VERDADE (só a
 * rede é sonda): digita na A, troca para a B, e o campo da B tem de estar
 * vazio — com o rascunho da A esperando por ela na volta.
 */

const { ORG, CONV_A, CONV_B, linha } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000028aa";
  const CONV_A = "00000000-0000-4000-8000-0000000028a1";
  const CONV_B = "00000000-0000-4000-8000-0000000028b1";
  const doisDiasAtras = new Date(Date.now() - 2 * 86_400_000).toISOString();
  // `janelaVencida`: canal oficial sem mensagem do paciente há 2 dias — o aviso
  // do modelo aparece. Sem ela, o canal não oficial, que escreve à vontade.
  const linha = (id: string, nome: string, janelaVencida = false) => ({
    id,
    organization_id: ORG,
    contact_id: `${id.slice(0, -2)}c1`,
    channel_session_id: "s-1",
    status: "open",
    tags: [],
    last_inbound_at: doisDiasAtras,
    channel_sessions: { provider: janelaVencida ? "meta_cloud" : "waha" },
    contacts: { id: `${id.slice(0, -2)}c1`, display_name: nome, name: null, phone_number: "+5527999990000", tags: [] },
  });
  return { ORG, CONV_A, CONV_B, linha };
});

const sendMock = vi.fn();
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
const uploadMock = vi.fn();
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));

const get = vi.fn(async (url: string): Promise<unknown> => {
  if (url.includes("/templates")) {
    return {
      data: {
        templates: [
          { name: "confirmacao_v2", language: "pt_BR", status: "APPROVED", slots: [], components: [] },
        ],
      },
    };
  }
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  // A busca única de uma conversa que saiu da lista: ainda em voo.
  if (url.startsWith("/api/v1/conversations/")) return new Promise(() => {});
  return { data: [] };
});
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (url: string) => get(url), post: vi.fn(), patch: vi.fn() },
}));
const LISTA = {
  data: { pages: [{ data: [linha(CONV_A, "Ana Fictícia"), linha(CONV_B, "Bruno Fictício")] }] },
  realtimeStatus: "ok",
};
function comJanelaVencida(vencida: boolean) {
  LISTA.data = {
    pages: [{ data: [linha(CONV_A, "Ana Fictícia", vencida), linha(CONV_B, "Bruno Fictício", vencida)] }],
  };
}
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
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <>
      <button onClick={() => onSelect(CONV_A)}>Abrir A</button>
      <button onClick={() => onSelect(CONV_B)}>Abrir B</button>
    </>
  ),
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

class GravadorDeMentira {
  static instancias: GravadorDeMentira[] = [];
  static isTypeSupported = () => true;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  constructor() {
    GravadorDeMentira.instancias.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1])], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONV_A} />
    </QueryClientProvider>
  );
  const r = render(arvore());
  return { renderDeNovo: () => r.rerender(arvore()) };
}

const campo = () => screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;
const abrir = (qual: "A" | "B") => fireEvent.click(screen.getByRole("button", { name: `Abrir ${qual}` }));

describe("item 28 — o campo é da conversa", () => {
  let pararMicrofone: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/app/inbox");
    comJanelaVencida(false);
    sendMock.mockClear();
    uploadMock.mockClear();
    GravadorDeMentira.instancias = [];
    pararMicrofone = vi.fn();
    vi.stubGlobal("MediaRecorder", GravadorDeMentira as unknown as typeof MediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: pararMicrofone }] })) },
    });
  });

  it("⭐ digita na A, troca para a B: o campo da B não traz o texto da A", async () => {
    montar();
    fireEvent.change(campo(), { target: { value: "Ana, sua consulta é amanhã às 9h" } });

    abrir("B");
    expect(campo().value).toBe("");

    // O Enter da B manda o texto da B, para a B.
    fireEvent.change(campo(), { target: { value: "Bruno, recebemos seu exame" } });
    fireEvent.keyDown(campo(), { key: "Enter" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![0]).toMatchObject({
      conversation_id: CONV_B,
      body: "Bruno, recebemos seu exame",
    });
  });

  it("o rascunho de cada conversa espera por ela — com o modo junto", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    fireEvent.change(campo(), { target: { value: "Ligar amanhã para confirmar" } });

    abrir("B");
    expect(campo().value).toBe("");
    expect(campo().placeholder, "a B abre respondendo, não em nota").toBe("Escreva uma mensagem…");
    fireEvent.change(campo(), { target: { value: "Rascunho do Bruno" } });

    abrir("A");
    expect(campo().value).toBe("Ligar amanhã para confirmar");
    expect(campo().placeholder, "a nota volta como nota").toMatch(/nota interna/i);

    abrir("B");
    expect(campo().value).toBe("Rascunho do Bruno");
  });

  it("a gravação de áudio para (e é descartada) ao trocar de conversa", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Gravar áudio" }));
    await screen.findByRole("button", { name: "Enviar áudio" });

    act(() => abrir("B"));
    expect(pararMicrofone).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Enviar áudio" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gravar áudio" })).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("o modelo escolhido na janela de 24 h não passa para a outra conversa", async () => {
    comJanelaVencida(true);
    montar();
    const seletor = await screen.findByRole("combobox", { name: "Modelo aprovado" });
    await waitFor(() => expect(seletor.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(seletor, { target: { value: "confirmacao_v2|pt_BR" } });
    expect((seletor as HTMLSelectElement).value).toBe("confirmacao_v2|pt_BR");

    abrir("B");
    const daB = await screen.findByRole("combobox", { name: "Modelo aprovado" });
    expect((daB as HTMLSelectElement).value).toBe("");
  });
});

describe("item 30 — a conversa aberta que sai da aba não pisca nem recria o campo", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app/inbox");
    comJanelaVencida(false);
  });

  it("⭐ some da lista (Não lidos, Assumir): o mesmo campo segue na tela, com o texto", () => {
    const tela = montar();
    const antes = campo();
    fireEvent.change(antes, { target: { value: "Ana, confirmo sua avaliação" } });

    // A aba deixou de devolver a A; a busca única dela ainda não respondeu.
    LISTA.data = { pages: [{ data: [linha(CONV_B, "Bruno Fictício")] }] };
    tela.renderDeNovo();

    expect(screen.queryByTestId("conversa-carregando")).toBeNull();
    expect(campo(), "o campo foi recriado").toBe(antes);
    expect(campo().value).toBe("Ana, confirmo sua avaliação");
  });
});
