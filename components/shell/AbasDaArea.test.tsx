import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { AbasDaArea } from "@/components/shell/AbasDaArea";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

// Spec 2026-10-07-cores-e-menu: as telas de cada área viram abas no topo, com a frase
// do que a tela faz; nenhuma rota muda.
const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
};
const rota = { atual: "/app/contacts" };
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef, usePermission: () => false }));
vi.mock("next/navigation", () => ({ usePathname: () => rota.atual }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("abas da área", () => {
  it("mostra as abas da área, marca a atual e explica a tela", () => {
    rota.atual = "/app/contacts";
    render(<AbasDaArea />);
    const abas = screen.getByRole("navigation", { name: "Telas de Vendas" });
    expect(within(abas).getByRole("link", { name: "Contatos" })).toHaveAttribute("aria-current", "page");
    expect(within(abas).getByRole("link", { name: "Funis" })).toHaveAttribute("href", "/app/kanban");
    expect(screen.getByText(/As pessoas do outro lado da conversa/)).toBeInTheDocument();
  });

  it("guarda a aba aberta para o menu lateral", () => {
    rota.atual = "/app/tasks";
    render(<AbasDaArea />);
    expect(JSON.parse(window.localStorage.getItem("menu-ultima-aba")!)).toMatchObject({ crm: "/app/tasks" });
  });

  it("quadro do funil marca a aba Funis", () => {
    rota.atual = "/app/pipelines/abc";
    render(<AbasDaArea />);
    expect(screen.getByRole("link", { name: "Funis" })).toHaveAttribute("aria-current", "page");
  });

  it("Início e rota sem área não mostram abas", () => {
    rota.atual = "/app/inicio";
    const { container } = render(<AbasDaArea />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    rota.atual = "/app/qualquer-coisa";
    const outra = render(<AbasDaArea />);
    expect(outra.container).toBeEmptyDOMElement();
  });

  it("telas além das principais ficam no Mais", () => {
    rota.atual = "/app/ai/agents";
    render(<AbasDaArea />);
    expect(screen.getByRole("button", { name: /Mais/ })).toBeInTheDocument();
  });
});
