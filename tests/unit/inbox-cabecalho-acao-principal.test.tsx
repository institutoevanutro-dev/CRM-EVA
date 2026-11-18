import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ClientModule from "@/lib/api/client";

const patchMock = vi.fn(async () => ({ data: {} }));
vi.mock("@/lib/api/client", async (importOriginal) => {
  const real = await importOriginal<typeof ClientModule>();
  return { ...real, apiClient: { ...real.apiClient, patch: (...a: unknown[]) => patchMock(...(a as [])) } };
});

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { BarraDeConversaFechada } from "@/components/inbox/BarraDeConversaFechada";

/**
 * CABEÇALHO DE APP DE MENSAGEM (pedido do André, 18/11/2026).
 *
 * Como no WhatsApp: só a foto, o nome e o número à vista. NENHUMA ação some:
 * todas moram no ⋯ da direita, com a ação principal (Assumir, Devolver ao
 * automático ou Reabrir) em primeiro; a situação (quem responde, o porquê, o
 * estado, a janela) vai para o alto do mesmo menu. Substitui a I3 do pacote de
 * design 2, que punha o principal e Transferir/Lembrar/Fechar à vista.
 *
 * jsdom não aplica CSS. A medida em pixels está nas specs e2e do Inbox.
 */

vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: "manager" } }),
}));
vi.mock("@/app/actions/settings/salvarAparenciaDaConversa", () => ({
  salvarAparenciaDaConversa: vi.fn(async () => ({ ok: true })),
}));

type Conversa = React.ComponentProps<typeof ConversationHeader>["conversation"];
const base = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: "ct-1",
  status: "open",
  assigned_to_user_id: null,
  assignee_kind: "ai",
  snooze_until: null,
  service_revision: 3,
  tags: [],
  contacts: { id: "ct-1", display_name: "Cliente Fictícia", name: null, phone_number: "+5511900000000" },
};

function renderHeader(extra: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={client}>
      <ConversationHeader
        conversation={{ ...base, ...extra } as unknown as Conversa}
        onBuscar={() => {}}
        onAbrirFicha={() => {}}
        aparencia={{ fundo: "liso", enviada: "marca", recebida: "branco" }}
        onAparenciaChange={() => {}}
      />
    </QueryClientProvider>,
  );
  // O menu é portal: a ação principal é procurada no documento.
  const principal = () => document.querySelector("[data-acao-principal]");
  return { ...r, principal };
}

const abrirMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Ações da conversa" }));
  return screen.getByTestId("menu-da-conversa");
};

describe("cabeçalho — só foto, nome e número à vista", () => {
  it("⭐ nenhum botão de ação nem selo fora do ⋯", () => {
    const { container } = renderHeader({ status: "open" });
    const cabecalho = container.querySelector("[data-cabecalho-da-conversa]") as HTMLElement;
    expect(within(cabecalho).getByRole("heading", { name: "Cliente Fictícia" })).toBeTruthy();
    expect(within(cabecalho).getByTestId("numero-do-contato").textContent).toMatch(/\d/);
    // O único botão à vista é o ⋯.
    expect(within(cabecalho).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Ações da conversa",
    ]);
    for (const selo of ["Sem responsável", "Aberta", "Automático"]) {
      expect(within(cabecalho).queryByText(selo), selo).toBeNull();
    }
  });
});

describe("cabeçalho — o menu ⋯: a ação principal em primeiro", () => {
  const primeiraAcao = (menu: HTMLElement) => within(menu).getAllByRole("button")[0]!;

  it("sem dono: Assumir é o primeiro item", () => {
    renderHeader();
    const menu = abrirMenu();
    expect(primeiraAcao(menu).textContent).toBe("Assumir");
    expect(primeiraAcao(menu).getAttribute("data-acao-principal")).toBe("assumir");
  });

  it("minha: nenhuma ação principal", () => {
    const { principal } = renderHeader({ assigned_to_user_id: "u-1", assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity" });
    abrirMenu();
    expect(principal()).toBeNull();
  });

  it("de colega com a pausa em vigor: Devolver ao automático em primeiro", () => {
    renderHeader({ assigned_to_user_id: "u-2", assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity" });
    const menu = abrirMenu();
    expect(primeiraAcao(menu).getAttribute("data-acao-principal")).toBe("devolver");
    expect(primeiraAcao(menu).getAttribute("data-testid")).toBe("devolver-ao-automatico");
  });

  it("encerrada: Reabrir, e sem Transferir, Lembrar nem Fechar", () => {
    renderHeader({ status: "closed" });
    const menu = abrirMenu();
    expect(primeiraAcao(menu).textContent).toBe("Reabrir");
    for (const nome of ["Transferir", "Lembrar", "Fechar conversa"]) {
      expect(within(menu).queryByRole("button", { name: nome })).toBeNull();
    }
  });

  it("aberta: Transferir, Lembrar e Fechar conversa no menu, com ícone e nome", () => {
    renderHeader();
    const menu = abrirMenu();
    for (const nome of ["Transferir", "Lembrar", "Fechar conversa"]) {
      const botao = within(menu).getByRole("button", { name: nome });
      expect(botao.querySelector("svg"), `${nome} sem ícone`).toBeTruthy();
    }
  });

  it("a situação mora no alto do menu: quem responde e o estado", () => {
    renderHeader();
    const menu = abrirMenu();
    const situacao = within(menu).getByRole("group", { name: "Situação da conversa" });
    expect(within(situacao).getByTestId("comando-da-conversa")).toBeTruthy();
    expect(situacao).toHaveTextContent("Aberta");
  });
});

describe("cabeçalho — o resto do menu ⋯", () => {
  const NO_MENU = [
    "Buscar nesta conversa",
    "Baixar a conversa em PDF",
    "Ocultar do Inbox",
    "Arquivar",
    "Aparência da conversa",
    "Ficha",
  ];

  it("abre por clique e contém os itens — nenhum deles fora dele", () => {
    renderHeader();
    const gatilho = screen.getByRole("button", { name: "Ações da conversa" });
    expect(gatilho.getAttribute("aria-expanded")).toBe("false");
    for (const nome of NO_MENU) {
      expect(screen.queryByRole("button", { name: nome }), `"${nome}" à vista fora do menu`).toBeNull();
    }
    const menu = abrirMenu();
    expect(gatilho.getAttribute("aria-expanded")).toBe("true");
    for (const nome of NO_MENU) {
      expect(within(menu).getByRole("button", { name: nome }), `"${nome}" faltou no menu`).toBeTruthy();
    }
  });

  it("conversa minha: Liberar e Devolver ao automático moram no menu", () => {
    renderHeader({ assigned_to_user_id: "u-1", assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity" });
    const menu = abrirMenu();
    expect(within(menu).getByRole("button", { name: "Liberar" })).toBeTruthy();
    expect(within(menu).getByTestId("devolver-ao-automatico")).toBeTruthy();
  });

  it("Arquivar fecha o menu e pergunta pelo ConfirmarNaTela", () => {
    renderHeader();
    fireEvent.click(within(abrirMenu()).getByRole("button", { name: "Arquivar" }));
    expect(screen.queryByTestId("menu-da-conversa")).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("Fechar conversa fecha o menu e pergunta, com o foco no Cancelar", () => {
    renderHeader();
    fireEvent.click(within(abrirMenu()).getByRole("button", { name: "Fechar conversa" }));
    expect(screen.queryByTestId("menu-da-conversa")).toBeNull();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Fechar esta conversa?");
    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
  });
});

describe("barra da conversa fechada — Reabrir e responder", () => {
  it("manda status claimed, sem revisão — nunca status open, que devolve à fila", async () => {
    patchMock.mockClear();
    const reabrir = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BarraDeConversaFechada conversationId="cv-9" onReabrir={reabrir} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Conversa fechada.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reabrir e responder" }));
    // O aviso sai NO CLIQUE: o pedido de foco tem de existir antes de a releitura
    // trocar a barra pelo campo (o foco em si é do InboxLayout, provado no e2e).
    expect(reabrir).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith("/api/v1/conversations/cv-9", { status: "claimed" });
  });

  it("conversa fechada: arquivo solto na tela continua recusado, sem a caixa de texto montada", () => {
    // A guarda que impede o PDF de abrir na aba no lugar do CRM morava só no
    // Composer — e a barra toma o lugar dele. Sem ela, soltar um arquivo no fio
    // de uma conversa fechada trocava o atendimento pelo arquivo.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BarraDeConversaFechada conversationId="cv-9" />
      </QueryClientProvider>,
    );
    const soltar = (tipos: string[]) => {
      const ev = new Event("dragover", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      ev.dataTransfer = { types: tipos, dropEffect: "copy" };
      screen.getByTestId("barra-conversa-fechada").dispatchEvent(ev);
      return ev;
    };
    const comArquivo = soltar(["Files"]);
    expect(comArquivo.defaultPrevented).toBe(true);
    expect((comArquivo.dataTransfer as { dropEffect: string }).dropEffect).toBe("none");
    // Texto e link seguem com o navegador.
    expect(soltar(["text/plain"]).defaultPrevented).toBe(false);
  });
});
