/**
 * Desde 07/10/2026 o menu lateral lista ÁREAS (spec 2026-10-07-cores-e-menu); as telas de
 * cada área viram abas no topo (AbasDaArea). Histórico — o Sidebar agrupado protegia:
 *
 *  - a hierarquia existe (o usuário reclamou de 17 itens no mesmo peso visual);
 *  - Funis é alcançável sem passar por Configurações — o achado que originou tudo;
 *  - agrupar não criou cabeçalho órfão (grupo cujos filhos a permissão filtrou);
 *  - colapsado não renderiza título nenhum: 6 rótulos em 64px seria ilegível.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
  ConnectionHealthDot: () => null,
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

  it("mostra só as áreas, na ordem de uso, e Configurações no rodapé", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(rotulos()).toEqual(["Início", "Atendimento", "Vendas", "IA", "Análise"]);
    expect(screen.getByRole("link", { name: "Configurações" })).toBeInTheDocument();
  });

  it("marca a área da tela atual, inclusive em tela de detalhe", () => {
    comoPapel("admin");
    rota.atual = "/app/pipelines/abc";
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: "Vendas" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Atendimento" })).not.toHaveAttribute("aria-current");
  });

  it("a área abre a última aba usada nela", async () => {
    comoPapel("admin");
    window.localStorage.setItem("menu-ultima-aba", JSON.stringify({ crm: "/app/tasks" }));
    rota.atual = "/app/inicio";
    render(<Sidebar collapsed={false} />);
    expect(await screen.findByRole("link", { name: "Vendas" })).toHaveAttribute("href", "/app/tasks");
  });

  it("sem aba guardada, a área abre a primeira aba", () => {
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
});
