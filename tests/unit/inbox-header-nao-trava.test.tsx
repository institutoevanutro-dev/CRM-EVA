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
  const acoes = () => screen.getByTestId("acoes-fixas-da-conversa");

  it("o grupo de ações NÃO é shrink-0 — era isso que impunha o piso de 707px", () => {
    const { container } = renderHeader();
    // Guarda de vacuidade: sem header renderizado, as asserções passariam por
    // não haver o que verificar.
    expect(container.firstElementChild, "o header não renderizou").toBeTruthy();
    expect(
      acoes().className.split(/\s+/),
      "`shrink-0` de volta no grupo de ações: o header volta a travar em 707px e o painel de CRM sai da tela em 1280px",
    ).not.toContain("shrink-0");
  });

  it("o header pode reorganizar em vez de esconder ação", () => {
    const { container } = renderHeader();
    const header = container.firstElementChild as HTMLElement;
    // As duas pontas: a linha quebra (os botões descem para baixo do nome) E o
    // grupo quebra por dentro. Só uma das duas não basta.
    expect(header.className).toContain("flex-wrap");
    expect((acoes().parentElement as HTMLElement).className).toContain("flex-wrap");
    expect(acoes().className).toContain("flex-wrap");
    expect(acoes().className).toContain("min-w-0");
  });

  it("Assumir, Transferir e Fechar continuam À VISTA — fora do menu ⋯ (I3)", () => {
    renderHeader();
    // O menu ⋯ fica fechado: o que se acha aqui está no grupo fixo.
    for (const rotulo of ["Assumir", "Transferir", "Fechar"]) {
      expect(within(acoes()).getByRole("button", { name: rotulo }), `a ação "${rotulo}" saiu da vista`).toBeTruthy();
    }
    // O rótulo do principal não muda: o atalho `a` e o dicionário o citam.
    expect(within(acoes()).getByRole("button", { name: "Assumir" }).textContent).toBe("Assumir");
  });

  it("no celular o telefone sai do cabeçalho (continua na Ficha) e o ⋯ tem 44px (porte do #3190)", () => {
    renderHeader();
    const telefone = screen.getByText(/5511999|\+55/).closest("p") as HTMLElement;
    expect(telefone.className.split(/\s+/)).toContain("max-md:hidden");
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
