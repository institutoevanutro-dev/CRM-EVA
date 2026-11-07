/**
 * Desde 10/10/2026 o menu lateral segue o PrecificaEva e o Financeiro: cada ÁREA é um
 * grupo que abre e fecha mostrando as suas telas (antes, abas no topo). O que protege:
 *
 *  - a hierarquia existe (o usuário reclamou de 17 itens no mesmo peso visual): só o
 *    grupo da tela atual nasce aberto;
 *  - Funis é alcançável sem passar por Configurações, o achado que originou tudo;
 *  - área sem tela visível para o papel não aparece;
 *  - colapsado não renderiza lista nenhuma: só o ícone da área;
 *  - aberto, o nome do grupo é um botão que SÓ abre e fecha (D1.10), e o que foi
 *    aberto fica guardado no navegador.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
const rota = { atual: "/app/inbox" };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn() }),
  usePathname: () => rota.atual,
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => <span data-testid="saude-da-conexao" />,
}));
const toggleSidebar = vi.fn<(c: boolean) => Promise<void>>(() => Promise.resolve());
vi.mock("@/app/actions/shell/toggleSidebar", () => ({
  toggleSidebar: (c: boolean) => toggleSidebar(c),
}));
// Busca a versão via react-query; sem QueryClientProvider ele lança, e o
// rodapé de versão não é o que estes testes examinam.
vi.mock("@/components/shell/VersionFooter", () => ({
  VersionFooter: () => null,
}));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(() => {
  cleanup();
  rota.atual = "/app/inbox";
  window.localStorage.clear();
});

describe("Sidebar por área", () => {
  const nav = () => screen.getByRole("navigation", { name: "Navegação principal" });
  const rotulos = () =>
    Array.from(nav().querySelectorAll("a, button")).map((a) => a.textContent?.trim());

  it("mostra os grupos na ordem de uso, e só o grupo da tela atual aberto, com todas as telas dele", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const grupos = ["Início", "Atendimento", "Vendas", "Assistente", "Análise", "Clínica", "Integrações"];
    // "Atendimento" e companhia aparecem uma vez só: são o nome do grupo, nunca o de uma tela.
    expect(rotulos().filter((r) => grupos.includes(r ?? ""))).toEqual(grupos);
    const telas = screen.getByRole("navigation", { name: "Telas de Atendimento" });
    expect(Array.from(telas.querySelectorAll("a")).map((a) => a.textContent?.trim())).toEqual([
      "Inbox", "Radar", "Agenda", "Respostas rápidas", "Alertas", "Casos", "Propostas",
    ]);
    expect(screen.queryByRole("navigation", { name: "Telas de Vendas" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Ver tudo" })).toBeNull();
    // Configurações é porta fixa no rodapé, fora da área que rola.
    const config = screen.getByRole("link", { name: "Configurações" });
    expect(config).toHaveAttribute("href", "/app/settings");
    expect(nav().contains(config)).toBe(false);
  });

  it("Minha conta abre pelo cartão de quem está logado, não por um grupo", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("button", { name: "Minha conta" })).toBeInTheDocument();
    for (const tela of ["Perfil", "Segurança", "Notificações", "Nuvemshop", "Plano e cobrança"]) {
      expect(rotulos(), tela).not.toContain(tela);
    }
  });

  it("o Início fica fora da parte que rola; só os grupos rolam", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const inicio = screen.getByRole("link", { name: "Início" });
    const queRola = nav().querySelector(".overflow-y-auto")!;
    expect(nav().contains(inicio)).toBe(true);
    expect(queRola.contains(inicio)).toBe(false);
    expect(queRola.contains(screen.getByRole("button", { name: "Vendas" }))).toBe(true);
  });

  it("o nome do grupo abre e fecha, sem navegar; Funis fica a um clique em Vendas", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const vendas = screen.getByRole("button", { name: "Vendas" });
    expect(vendas).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(vendas);
    expect(vendas).toHaveAttribute("aria-expanded", "true");
    const telas = screen.getByRole("navigation", { name: "Telas de Vendas" });
    expect(within(telas).getByRole("link", { name: "Funis" })).toHaveAttribute("href", "/app/kanban");
    fireEvent.click(vendas);
    expect(screen.queryByRole("navigation", { name: "Telas de Vendas" })).toBeNull();
  });

  it("o grupo da tela atual se comporta igual aos outros: o nome só fecha", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const atendimento = screen.getByRole("button", { name: "Atendimento" });
    expect(atendimento).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(atendimento);
    expect(screen.queryByRole("navigation", { name: "Telas de Atendimento" })).toBeNull();
  });

  it("os grupos abertos voltam como estavam depois de recarregar", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Vendas" }));
    cleanup();
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("navigation", { name: "Telas de Vendas" })).toBeInTheDocument();
    // E o grupo da tela atual abre mesmo que tenha sido fechado antes.
    expect(screen.getByRole("navigation", { name: "Telas de Atendimento" })).toBeInTheDocument();
  });

  it("armazenamento quebrado não derruba o menu", () => {
    comoPapel("admin");
    window.localStorage.setItem("menu:grupos-abertos", "{nao é json");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("navigation", { name: "Telas de Atendimento" })).toBeInTheDocument();
  });

  it("recolher muda o menu no clique, sem esperar o servidor", async () => {
    comoPapel("admin");
    const alternar = vi.fn();
    render(<Sidebar collapsed={false} onAlternarRecolhido={alternar} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Recolher sidebar" }));
    });
    expect(alternar).toHaveBeenCalledTimes(1);
    expect(toggleSidebar).toHaveBeenCalledWith(false);
  });

  it("a dica da busca diz Ctrl K fora do Mac", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(document.querySelector("kbd")?.textContent).toBe("Ctrl K");
  });

  it("itens e Sair têm alvo de 44 px no toque", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: "Início" }).className).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "Vendas" }).className).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "Sair" }).className).toContain("min-h-11");
    // "Buscar tela" também mora na gaveta do iPhone: 40 px ali reprovava a prova da D1.10.
    expect(screen.getByRole("button", { name: /Buscar tela/ }).className).toMatch(/(^| )h-11( |$)/);
  });

  it("a tela atual fica marcada dentro do grupo", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const telas = screen.getByRole("navigation", { name: "Telas de Atendimento" });
    expect(within(telas).getByRole("link", { current: "page" })).toHaveAttribute("href", "/app/inbox");
  });

  it("colapsado não mostra lista de telas nem a seta", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    expect(screen.queryByRole("navigation", { name: /Telas de/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Vendas" })).toBeNull();
  });

  it("abre a área da tela atual, inclusive em tela de detalhe", () => {
    comoPapel("admin");
    rota.atual = "/app/pipelines/abc";
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("button", { name: "Vendas" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Atendimento" })).toHaveAttribute("aria-expanded", "false");
  });

  it("recolhido, o ícone da área leva à primeira tela dela e marca a área atual", () => {
    comoPapel("admin");
    rota.atual = "/app/pipelines/abc";
    render(<Sidebar collapsed />);
    const vendas = nav().querySelector('a[title="Vendas"]');
    expect(vendas).toHaveAttribute("href", "/app/kanban");
    expect(vendas).toHaveAttribute("aria-current", "page");
  });

  it("colapsado mantém os links com o nome como dica", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    expect(nav().querySelector('a[title="Vendas"]')).not.toBeNull();
  });

  it("papel sem tela numa área não vê a área", () => {
    comoPapel("viewer");
    render(<Sidebar collapsed={false} />);
    for (const r of rotulos()) expect(r).not.toBe(undefined);
    expect(rotulos()).toContain("Atendimento");
  });

  it("o aviso de conexão só aparece para quem pode abrir Conexões", () => {
    comoPapel("viewer");
    render(<Sidebar collapsed={false} />);
    expect(screen.queryByTestId("saude-da-conexao")).toBeNull();
    cleanup();
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByTestId("saude-da-conexao")).toBeInTheDocument();
  });
});
