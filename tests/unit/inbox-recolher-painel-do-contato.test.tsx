import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RECOLHER O PAINEL DO CONTATO (porte do original #3043, de @webtecnica).
 *
 * Só o menu da esquerda tinha como recolher; a ficha do contato ocupava a
 * direita sempre. Estes casos prendem as três metades da entrega:
 *
 *   1. o CLIQUE: recolher esconde o painel inteiro e o trilho recolhido sempre
 *      tem o botão de expandir (senão o painel sumiria sem porta de volta);
 *   2. a LARGURA: recolhida, a grade troca a trilha da ficha pelo trilho de
 *      44px (2.75rem), na classe e no estilo inline da divisória ajustada;
 *   3. a PREFERÊNCIA: a tela nasce do valor que o SERVIDOR leu do cookie
 *      (`painelRecolhidoInicial`), e cada clique grava pelo server action.
 *
 * O estado mora na GRADE (`InboxLayout`): por isso o alvo é o layout montado
 * de verdade, com o `CRMSidePanel` real dentro.
 */

const get = vi.hoisted(() => vi.fn());
const togglePainelDoContato = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/app/actions/inbox/togglePainelDoContato", () => ({ togglePainelDoContato }));

const ORG = "00000000-0000-4000-8000-0000000005aa";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "00000000-0000-4000-8000-0000000005a1";

const conversa = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: CONTATO,
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  bot_silenced_until: null,
  last_inbound_at: "2026-09-15T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: { provider: "waha" },
  contacts: {
    id: CONTATO,
    display_name: "Contato Fictício",
    name: null,
    phone_number: "5511900000000",
    tags: [],
    is_anonymized: false,
  },
};

const resumo = {
  data: {
    leads: [
      {
        id: "l-1",
        title: "Negócio fictício",
        status: "open",
        value_cents: null,
        currency: null,
        updated_at: "2026-09-15T12:00:00Z",
        pipeline_id: "p-1",
        stage_id: "s-1",
        custom_fields: {},
        field_defs: [],
        funil_nome: "Origem",
        etapa_nome: "Novo",
        etapas_do_funil: [{ id: "s-1", name: "Novo", is_won: false, is_lost: false }],
      },
    ],
    orders: [],
    activities: [],
    demandas: [],
    fatos: [],
    historico: [],
  },
};

get.mockImplementation(async (url?: string) => {
  const bruto = url ?? "";
  if (bruto === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (bruto.includes("crm-summary")) return resumo;
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({
  useConversationsRealtime: () => ({
    data: { pages: [{ data: [conversa] }] },
    realtimeStatus: "ok",
    seguranca: { divergencias: 0 },
  }),
}));
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
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", role: "admin", support: null, is_platform_admin: false },
    activeOrg: { orgId: ORG, name: "Org", role: "admin" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
// As irmãs do Inbox não são o alvo e trazem fetch próprio.
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/inbox/PainelIniciarConversa", () => ({ BotaoIniciarConversa: () => null }));
vi.mock("@/components/inbox/TarefasDoAtendimento", () => ({ TarefasDoAtendimento: () => null }));
// Dependências do painel (o painel em si é REAL: é ele que desenha o controle).
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false, isLoading: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { InboxLayout } from "@/components/inbox/InboxLayout";
import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

beforeAll(() => {
  // A faixa `xl` é onde a ficha existe como coluna (`md` não tem ficha).
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: 1040,
      left: 0,
      right: 1040,
      top: 0,
      bottom: 800,
      x: 0,
      y: 0,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect;
  };
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  togglePainelDoContato.mockClear();
  window.localStorage.clear();
});

function montar(painelRecolhidoInicial = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONVERSA} painelRecolhidoInicial={painelRecolhidoInicial} />
    </QueryClientProvider>,
  );
}

/** A GRADE: é ela quem redistribui a largura entre lista, conversa e ficha. */
function grade(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-realtime-status]");
  if (!el) throw new Error("a grade do Inbox não renderizou");
  return el;
}

const trilhaDaFicha = "xl:grid-cols-[272px_1fr_296px]";
const trilhaDoTrilho = "xl:grid-cols-[272px_1fr_2.75rem]";

const botaoRecolher = () => screen.getByRole("button", { name: "Recolher painel do contato" });
const botaoExpandir = () => screen.getByRole("button", { name: "Expandir painel do contato" });

describe("Inbox: recolher o painel do contato (porte do #3043)", () => {
  it("aberto: o painel desenha o conteúdo e o controle no alto, com o ícone do menu da esquerda", async () => {
    montar();
    await screen.findByTestId("inbox-demandas");
    expect(screen.queryByTestId("inbox-painel-recolhido")).toBeNull();
    expect(grade().className).toContain(trilhaDaFicha);
    expect(grade().className).not.toContain(trilhaDoTrilho);
    const botao = botaoRecolher();
    // O rótulo nomeia o que o botão FAZ e o alvo; o title repete para o mouse.
    expect(botao).toHaveAttribute("title", "Recolher painel do contato");
    expect(botao).toHaveAttribute("aria-expanded", "true");
    // O controle vem ANTES da primeira seção (no alto do painel).
    const demandas = screen.getByTestId("inbox-demandas");
    expect(botao.compareDocumentPosition(demandas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clicar recolhe o painel inteiro: só o trilho fica, e a conversa ganha a largura", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("inbox-demandas");

    await user.click(botaoRecolher());

    // O conteúdo sumiu: não é uma seção interna, é o painel todo.
    expect(screen.queryByTestId("inbox-demandas")).toBeNull();
    expect(screen.queryByTestId("inbox-campos-lead")).toBeNull();
    // Ficou o trilho, com a porta de volta.
    expect(screen.getByTestId("inbox-painel-recolhido")).toBeInTheDocument();
    expect(botaoExpandir()).toHaveAttribute("aria-expanded", "false");
    // A grade devolve a largura: a trilha da ficha vira o trilho estreito.
    await waitFor(() => expect(grade().className).toContain(trilhaDoTrilho));
    expect(grade().className).not.toContain(trilhaDaFicha);
    // A preferência vai para o servidor pelo mesmo caminho do `toggleSidebar`,
    // com o estado ATUAL.
    expect(togglePainelDoContato).toHaveBeenCalledWith(false);
  });

  it("clicar de novo traz o painel de volta, com as demandas ainda recolhidas", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("inbox-demandas");

    await user.click(botaoRecolher());
    await waitFor(() => expect(screen.getByTestId("inbox-painel-recolhido")).toBeInTheDocument());

    await user.click(botaoExpandir());

    expect(screen.queryByTestId("inbox-painel-recolhido")).toBeNull();
    expect(await screen.findByTestId("inbox-demandas")).toBeInTheDocument();
    // "Demandas abertas" segue recolhida por padrão depois de reabrir o painel.
    expect(screen.getByRole("button", { name: /Demandas abertas/ })).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(grade().className).toContain(trilhaDaFicha));
    expect(grade().className).not.toContain(trilhaDoTrilho);
    expect(togglePainelDoContato).toHaveBeenLastCalledWith(true);
  });

  it("a preferência do servidor vence na primeira pintura: nasce recolhido", async () => {
    montar(true);
    expect(await screen.findByTestId("inbox-painel-recolhido")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-demandas")).toBeNull();
    expect(grade().className).toContain(trilhaDoTrilho);
    // Nada foi gravado só por abrir a tela.
    expect(togglePainelDoContato).not.toHaveBeenCalled();
  });

  it("a divisória da ficha some quando não há ficha para ajustar", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("inbox-demandas");
    expect(screen.getAllByRole("separator")).toHaveLength(2);

    await user.click(botaoRecolher());

    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(document.querySelector('[data-divisoria="ficha"]')).toBeNull();
  });

  it("recolhido com a divisória ajustada (xl): o estilo inline troca a ficha pelo trilho de 44px", async () => {
    // Com largura salva quem manda é o `style` da grade, não a classe.
    window.localStorage.setItem("inbox:divisorias:xl", JSON.stringify({ lista: 300, ficha: 320 }));
    montar(true);
    await screen.findByTestId("inbox-painel-recolhido");
    await waitFor(() => expect(grade().style.gridTemplateColumns).toBe("300px minmax(0,1fr) 2.75rem"));
  });

  it("recolhido numa tela sem ficha em coluna (768 a 1279px): nenhuma trilha vazia à direita", async () => {
    window.innerWidth = 1000;
    try {
      window.localStorage.setItem("inbox:divisorias:md", JSON.stringify({ lista: 320, ficha: 300 }));
      montar(true);
      await waitFor(() => expect(grade().style.gridTemplateColumns).toBe("320px minmax(0,1fr)"));
    } finally {
      window.innerWidth = 1440;
    }
  });
});

describe("painel do celular (Sheet): o controle de recolher não aparece", () => {
  it("sem `onAlternarRecolhido` o painel desenha inteiro, mesmo com `recolhido`", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CRMSidePanel
          conversation={conversa as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"]}
          recolhido
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("inbox-demandas")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-painel-recolhido")).toBeNull();
    expect(screen.queryByTestId("inbox-recolher-painel")).toBeNull();
  });
});
