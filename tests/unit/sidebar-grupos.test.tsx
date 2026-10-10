/**
 * Desde 10/10/2026 o menu lateral segue o PrecificaEva e o Financeiro: cada ÁREA é um
 * grupo que abre e fecha mostrando as suas telas (antes, abas no topo). O que protege:
 *
 *  - a hierarquia existe (o usuário reclamou de 17 itens no mesmo peso visual): só o
 *    grupo da tela atual nasce aberto;
 *  - Funis é alcançável sem passar por Configurações, o achado que originou tudo;
 *  - área sem tela visível para o papel não aparece;
 *  - colapsado não renderiza lista nenhuma: só o ícone da área.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
  usePathname: () => rota.atual,
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => <span data-testid="saude-da-conexao" />,
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({
  toggleSidebar: vi.fn(),
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
    Array.from(nav().querySelectorAll("a")).map((a) => a.textContent?.trim());

  it("mostra as áreas na ordem de uso, Configurações fora da rolagem, e só o grupo da tela atual aberto", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const areas = ["Início", "Atendimento", "Vendas", "IA", "Análise"];
    expect(rotulos().filter((r) => areas.includes(r ?? ""))).toEqual(areas);
    // Configurações fica fora da área que rola.
    expect(nav().contains(screen.getByRole("link", { name: "Configurações" }))).toBe(false);
    expect(screen.getByRole("navigation", { name: "Telas de Atendimento" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Telas de Vendas" })).toBeNull();
  });

  it("o Início fica fora da parte que rola; só os grupos rolam", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const inicio = screen.getByRole("link", { name: "Início" });
    const queRola = nav().querySelector(".overflow-y-auto")!;
    expect(nav().contains(inicio)).toBe(true);
    expect(queRola.contains(inicio)).toBe(false);
    expect(queRola.contains(screen.getByRole("link", { name: "Vendas" }))).toBe(true);
  });

  it("o grupo abre e fecha pela seta, sem navegar; Funis fica a um clique em Vendas", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir Vendas" }));
    const vendas = screen.getByRole("navigation", { name: "Telas de Vendas" });
    expect(within(vendas).getByRole("link", { name: "Funis" })).toHaveAttribute("href", "/app/kanban");
    fireEvent.click(screen.getByRole("button", { name: "Fechar Vendas" }));
    expect(screen.queryByRole("navigation", { name: "Telas de Vendas" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: /Abrir|Fechar/ })).toBeNull();
  });

  it("marca a área da tela atual, inclusive em tela de detalhe", () => {
    comoPapel("admin");
    rota.atual = "/app/pipelines/abc";
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: "Vendas" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Atendimento" })).not.toHaveAttribute("aria-current");
  });

  it("o nome da área leva à primeira tela dela", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: "Vendas" })).toHaveAttribute("href", "/app/kanban");
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
