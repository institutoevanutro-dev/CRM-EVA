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
 * I3 DO PACOTE DE DESIGN 2 — AÇÃO PRINCIPAL SEMPRE À VISTA.
 *
 * A faixa que aparecia com o mouse saiu do cabeçalho. Ficam à vista: um botão
 * principal que muda com o estado, e Transferir/Lembrar/Fechar com ícone e nome
 * (o nome sai por consulta de contêiner e fica na dica e no `aria-label`). O
 * resto mora num menu ⋯ aberto por clique.
 *
 * jsdom não aplica CSS: a consulta de contêiner é lida pela classe. A medida em
 * pixels está nas specs e2e do Inbox.
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
  const fixas = screen.getByTestId("acoes-fixas-da-conversa");
  const principal = () => r.container.querySelector("[data-acao-principal]");
  return { ...r, fixas, principal };
}

const abrirMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Ações da conversa" }));
  return screen.getByTestId("menu-da-conversa");
};

describe("cabeçalho — o botão principal muda com o estado", () => {
  it("sem dono: Assumir, à vista sem passar o mouse", () => {
    const { principal } = renderHeader();
    expect(principal()?.textContent).toBe("Assumir");
  });

  it("minha: nenhum botão principal", () => {
    const { principal } = renderHeader({ assigned_to_user_id: "u-1", assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity" });
    expect(principal()).toBeNull();
  });

  it("de colega com a pausa em vigor: Devolver ao automático", () => {
    const { principal } = renderHeader({ assigned_to_user_id: "u-2", assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity" });
    expect(principal()?.getAttribute("data-acao-principal")).toBe("devolver");
    expect(principal()?.getAttribute("data-testid")).toBe("devolver-ao-automatico");
  });

  it("encerrada: Reabrir, e sem Transferir, Lembrar nem Fechar", () => {
    const { principal, fixas } = renderHeader({ status: "closed" });
    expect(principal()?.textContent).toBe("Reabrir");
    for (const nome of ["Transferir", "Lembrar", "Fechar"]) {
      expect(within(fixas).queryByRole("button", { name: nome })).toBeNull();
    }
  });
});

describe("cabeçalho — Transferir, Lembrar e Fechar fixos", () => {
  it("à vista, com ícone, e o nome na dica e no aria-label quando o cabeçalho estreita", () => {
    const { container, fixas } = renderHeader();
    expect((container.firstElementChild as HTMLElement).className.split(/\s+/)).toContain("@container");
    for (const nome of ["Transferir", "Lembrar", "Fechar"]) {
      const botao = within(fixas).getByRole("button", { name: nome });
      expect(botao.getAttribute("title")).toBe(nome);
      expect(botao.querySelector("svg"), `${nome} sem ícone`).toBeTruthy();
      const rotulo = within(botao).getByText(nome);
      expect(rotulo.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "@[40rem]:inline"]));
    }
  });
});

describe("cabeçalho — o menu ⋯", () => {
  const MOVIDOS = [
    "Buscar nesta conversa",
    "Baixar a conversa em PDF",
    "Ocultar do Inbox",
    "Arquivar",
    "Aparência da conversa",
    "Ficha",
  ];

  it("abre por clique e contém os itens movidos — nenhum deles fora dele", () => {
    const { fixas } = renderHeader();
    const gatilho = screen.getByRole("button", { name: "Ações da conversa" });
    expect(gatilho.getAttribute("aria-expanded")).toBe("false");
    for (const nome of MOVIDOS) {
      expect(screen.queryByRole("button", { name: nome }), `"${nome}" à vista fora do menu`).toBeNull();
    }
    const menu = abrirMenu();
    expect(gatilho.getAttribute("aria-expanded")).toBe("true");
    for (const nome of MOVIDOS) {
      expect(within(menu).getByRole("button", { name: nome }), `"${nome}" faltou no menu`).toBeTruthy();
      expect(within(fixas).queryByRole("button", { name: nome })).toBeNull();
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
});

describe("barra da conversa fechada — Reabrir e responder", () => {
  it("manda status claimed, sem revisão — nunca status open, que devolve à fila", async () => {
    patchMock.mockClear();
    const reaberta = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BarraDeConversaFechada conversationId="cv-9" onReaberta={reaberta} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Conversa fechada.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reabrir e responder" }));
    await waitFor(() => expect(reaberta).toHaveBeenCalled());
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("/api/v1/conversations/cv-9", { status: "claimed" });
  });
});
