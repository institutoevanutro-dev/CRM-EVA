import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";

/**
 * O CABEÇALHO DA CONVERSA: fixo só o que se LÊ, ações quando se PEDE.
 *
 * Pedido do dono (16/10/2026): nome, telefone e responsável sempre à vista; a
 * fileira de Transferir/Lembrar/Fechar/Arquivar/PDF/busca/Assumir aparece ao
 * passar o mouse ou focar — e por um botão explícito, porque toque e teclado não
 * têm "passar o mouse". Medido antes: 152px de cabeçalho em 1280px, duas
 * fileiras de botões em cima da conversa.
 *
 * jsdom não aplica CSS, então a visibilidade é lida pelo estado que o CSS usa
 * (`data-visivel` + `invisible`) e pelo `aria-expanded` do botão. A medida em
 * pixels está na spec e2e `inbox-aparencia-e-acoes-sob-demanda`.
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

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: "ct-1",
  status: "open",
  assigned_to_user_id: null,
  assignee_kind: "ai",
  snooze_until: null,
  tags: [],
  contacts: { id: "ct-1", display_name: "Cliente Fictícia", name: null, phone_number: "+5511900000000" },
} as unknown as React.ComponentProps<typeof ConversationHeader>["conversation"];

function renderHeader() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={client}>
      <ConversationHeader
        conversation={conversation}
        onBuscar={() => {}}
        aparencia={{ fundo: "liso", enviada: "marca", recebida: "branco" }}
        onAparenciaChange={() => {}}
      />
    </QueryClientProvider>,
  );
  const header = r.container.firstElementChild as HTMLElement;
  const faixa = header.children[1] as HTMLElement;
  const alternador = screen.getByRole("button", { name: "Ações da conversa" });
  return { ...r, header, faixa, alternador };
}

const escondida = (faixa: HTMLElement) =>
  faixa.dataset.visivel === "false" && faixa.className.split(/\s+/).includes("invisible");

describe("cabeçalho da conversa — ações sob demanda", () => {
  it("fixo: nome, telefone e quem responde; as ações começam recolhidas", () => {
    const { header, faixa, alternador } = renderHeader();
    const fixo = header.children[0] as HTMLElement;
    expect(within(fixo).getByText("Cliente Fictícia")).toBeTruthy();
    expect(within(fixo).getByText(/\+55/)).toBeTruthy();
    expect(within(fixo).getByTestId("comando-da-conversa")).toBeTruthy();
    // Nenhuma ação na linha fixa — só o botão que as revela.
    for (const rotulo of ["Assumir", "Transferir", "Fechar", "Arquivar"]) {
      expect(within(fixo).queryByText(rotulo), `"${rotulo}" ficou na linha fixa`).toBeNull();
      expect(within(faixa).getByText(rotulo), `"${rotulo}" sumiu do cabeçalho`).toBeTruthy();
    }
    expect(within(faixa).getByRole("button", { name: "Buscar nesta conversa" })).toBeTruthy();
    expect(within(faixa).getByRole("button", { name: "Aparência da conversa" })).toBeTruthy();
    expect(escondida(faixa), "a faixa nasce visível").toBe(true);
    expect(alternador.getAttribute("aria-expanded")).toBe("false");
    expect(alternador.getAttribute("aria-controls")).toBe(faixa.id);
  });

  it("o botão abre e FIXA (toque e teclado), e fixada a faixa entra no fluxo", () => {
    const { faixa, alternador } = renderHeader();
    fireEvent.click(alternador);
    expect(alternador.getAttribute("aria-expanded")).toBe("true");
    expect(escondida(faixa)).toBe(false);
    expect(faixa.className, "fixada não pode flutuar por cima das mensagens").not.toContain("absolute");
    fireEvent.click(alternador);
    expect(alternador.getAttribute("aria-expanded")).toBe("false");
    expect(escondida(faixa)).toBe(true);
  });

  it("mouse passando revela (flutuando); toque passando NÃO", () => {
    const { header, faixa } = renderHeader();
    fireEvent.pointerEnter(header, { pointerType: "touch" });
    expect(escondida(faixa), "toque abriu a faixa sem pedir").toBe(true);
    fireEvent.pointerEnter(header, { pointerType: "mouse" });
    expect(escondida(faixa)).toBe(false);
    expect(faixa.className).toContain("absolute");
    fireEvent.pointerLeave(header, { pointerType: "mouse" });
    expect(escondida(faixa)).toBe(true);
  });

  it("foco no botão revela (Tab chega nas ações sem mouse)", () => {
    const { faixa, alternador } = renderHeader();
    fireEvent.focus(alternador);
    expect(escondida(faixa)).toBe(false);
    fireEvent.blur(alternador, { relatedTarget: document.body });
    expect(escondida(faixa)).toBe(true);
  });

  it("Escape fecha e devolve o foco ao botão (WCAG 1.4.13)", () => {
    const { faixa, alternador } = renderHeader();
    fireEvent.click(alternador);
    const transferir = within(faixa).getByText("Transferir");
    transferir.focus();
    fireEvent.keyDown(transferir, { key: "Escape" });
    expect(escondida(faixa)).toBe(true);
    expect(document.activeElement).toBe(alternador);
  });

  it("usar uma ação mantém a faixa aberta (o menu em portal leva o foco embora)", () => {
    const { header, faixa } = renderHeader();
    fireEvent.pointerEnter(header, { pointerType: "mouse" });
    fireEvent.pointerDown(within(faixa).getByText("Transferir"));
    // O foco foi para um diálogo fora do cabeçalho; o mouse saiu.
    const fora = document.createElement("button");
    document.body.appendChild(fora);
    fora.focus();
    fireEvent.pointerLeave(header, { pointerType: "mouse" });
    expect(escondida(faixa), "a faixa sumiu por baixo do menu aberto").toBe(false);
    fora.remove();
  });
});

describe("cabeçalho da conversa — o clique de quem já vê a faixa", () => {
  it("mouse em cima (faixa já revelada) e clique no botão: FIXA, não fecha", () => {
    const { header, faixa, alternador } = renderHeader();
    fireEvent.pointerEnter(header, { pointerType: "mouse" });
    fireEvent.click(alternador);
    fireEvent.pointerLeave(header, { pointerType: "mouse" });
    expect(escondida(faixa), "o clique fechou a faixa que a pessoa pediu para ver").toBe(false);
  });

  it("Tab no botão (faixa já revelada pelo foco) e Enter: FIXA, não fecha", () => {
    const { faixa, alternador } = renderHeader();
    fireEvent.focus(alternador);
    fireEvent.click(alternador);
    fireEvent.blur(alternador, { relatedTarget: document.body });
    expect(escondida(faixa)).toBe(false);
  });
});
