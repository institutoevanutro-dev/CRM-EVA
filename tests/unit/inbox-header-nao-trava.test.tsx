import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";

/**
 * CATRACA: o header do inbox não pode voltar a travar a largura da tela.
 *
 * ## O defeito, medido
 *
 * A barra de ações deste header era `shrink-0`. Como ela não encolhia nem
 * quebrava, o `min-content` do header inteiro era **707px** — e a coluna do
 * meio do inbox é `1fr`, que é `minmax(auto, 1fr)` e não encolhe abaixo do
 * conteúdo. Resultado: o painel de CRM ficava **311px fora da viewport em
 * 1280px**. Em uma resolução de trabalho comum, o atendente não via contexto
 * nenhum do cliente.
 *
 * ## Por que este teste é o que é (e o que ele NÃO é)
 *
 * Este teste olha CLASSE, não pixel — e isso é uma limitação declarada, não um
 * descuido: `min-content`, quebra de flex e resolução de grid são cálculo de
 * layout, e o jsdom não tem engine de layout. Medir largura aqui devolveria
 * zero em tudo e passaria feliz: verde por ausência de motor.
 *
 * A medição de verdade é `tests/sonda-inbox-cabe-na-tela.ts`, que roda num
 * browser e afere as 5 larguras. Esta catraca existe porque aquela sonda não
 * roda no CI, e a regressão específica — alguém devolver `shrink-0` à barra de
 * ações "para os botões não quebrarem" — é textual e barata de pegar.
 *
 * Se um dia o CI ganhar um passo de browser, este arquivo pode morrer em favor
 * da sonda. Enquanto isso, ele é a única coisa entre a regressão e a main.
 *
 * Desde 18/11/2026 o cabeçalho é o de app de mensagem (foto, nome, número e o
 * ⋯): não há mais barra de ações para travar. A catraca passou a vigiar o que
 * sobrou para travar — o nome que trunca em vez de empurrar, e o ⋯ que nunca
 * encolhe —, e que as ações não sumiram: estão no menu.
 */

vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  // O header passou a importar `useArchiveConversation` do MESMO módulo (issue
  // #923). Um dublê fechado que não acompanha a nova exportação não falha com
  // "faltou mock": falha com "useArchiveConversation is not a function", que
  // não fala nada do que este arquivo vigia.
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
// O nome do módulo importa: a primeira versão deste arquivo mockava
// "useResumeAi", que NÃO EXISTE — o real é `useResumeAiAttendance`. O teste
// passou assim mesmo (o hook verdadeiro rodou sob o provider), ou seja, o mock
// não mockava nada e ninguém era avisado. Mock de caminho inexistente é ruído
// que parece cobertura.
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: "manager" } }),
}));

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: "ct-1",
  status: "open",
  assigned_to_user_id: null,
  assignee_kind: "ai",
  snooze_until: null,
  tags: [],
  contacts: { id: "ct-1", display_name: "Fulana", name: null, phone_number: "5511999" },
} as unknown as React.ComponentProps<typeof ConversationHeader>["conversation"];

function renderHeader() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationHeader conversation={conversation} />
    </QueryClientProvider>,
  );
}

describe("header do inbox — não trava a largura da tela", () => {
  it("o nome encolhe e trunca; o ⋯ não encolhe", () => {
    const { container } = renderHeader();
    const header = container.querySelector("[data-cabecalho-da-conversa]") as HTMLElement;
    // Guarda de vacuidade: sem header, as asserções passariam por não haver o que ver.
    expect(header, "o header não renderizou").toBeTruthy();
    expect(header.className).toContain("min-w-0");
    const nome = screen.getByRole("heading", { name: "Fulana" });
    expect(nome.className).toContain("truncate");
    expect((nome.parentElement as HTMLElement).className).toContain("min-w-0");
    const gatilho = screen.getByRole("button", { name: "Ações da conversa" });
    expect(gatilho.className.split(/\s+/)).toContain("shrink-0");
  });

  it("Assumir, Transferir e Fechar não somem: estão no ⋯, com o rótulo de sempre", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Ações da conversa" }));
    const menu = screen.getByTestId("menu-da-conversa");
    for (const rotulo of ["Assumir", "Transferir", "Fechar conversa"]) {
      expect(within(menu).getByRole("button", { name: rotulo }), `a ação "${rotulo}" sumiu`).toBeTruthy();
    }
    // O rótulo do principal não muda: o atalho `a` e o dicionário o citam.
    expect(within(menu).getByRole("button", { name: "Assumir" }).textContent).toBe("Assumir");
  });

  it("o número fica à vista (como no WhatsApp) e o ⋯ tem 44px no toque (porte do #3190)", () => {
    renderHeader();
    expect(screen.getByTestId("numero-do-contato").textContent).toMatch(/5511999|\+55/);
    // `size="sm"` dá `h-11` (44px) abaixo do `lg`; o `md:h-9` devolve os 36px
    // a partir do `md`. Um `h-9` sem prefixo voltaria a 36px no toque.
    const classes = screen.getByRole("button", { name: "Ações da conversa" }).className.split(/\s+/);
    expect(classes).toContain("h-11");
    expect(classes).toContain("md:h-9");
    expect(classes).not.toContain("h-9");
  });

  it('"Ver contato" mora no ⋯ e só se cala onde há outra porta', () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Ações da conversa" }));
    // Some por CSS a partir de `xl`, a largura em que o painel lateral entra com
    // um "Ver contato" próprio. Remover do DOM tiraria a ação de quem usa 1024px.
    const link = screen.getByText("Ver contato").closest("a, button") as HTMLElement;
    expect(link, "o link para o contato sumiu do markup").toBeTruthy();
    expect(link.className).toContain("xl:hidden");
  });
});
