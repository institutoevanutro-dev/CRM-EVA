import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PipelinePageClient } from "./_client";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// components/kanban/MoveToOtherPipelineDialog.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Troca rápida de funil no cabeçalho do quadro.
 *
 * O `h1` com o nome do funil vira o gatilho de um `Select` quando há mais de
 * um funil vivo: pular de funil sem voltar à lista. Com um funil só, `h1`
 * puro (seletor de uma opção é ruído permanente).
 *
 * Porte de melgarafael/DeskcommCRM#2731 (@paulolimajr77).
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useFechadosAntigos: () => ({ data: undefined, isLoading: false }),
  useBoard: () => ({
    data: {
      pipeline: { id: "p-1", name: "Vendas", vocabulary: null, settings: null },
      stages: [],
      leads: [],
    },
    isLoading: false,
    error: null,
    pulses: new Map(),
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
  usePermission: () => false,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/KanbanBoard", () => ({ KanbanBoard: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));

const FUNIS = [
  { id: "p-1", name: "Vendas" },
  { id: "p-2", name: "Suporte" },
  { id: "p-3", name: "Parcerias" },
];

beforeEach(() => push.mockClear());

describe("troca rápida de funil", () => {
  it("com um funil só, mostra o h1 e nenhum seletor", () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
       
        funis={[{ id: "p-1", name: "Vendas" }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("com vários funis, o título vira seletor com os funis vivos", async () => {
    render(
      <PipelinePageClient pipelineId="p-1" initialName="Vendas" funis={FUNIS} />,
    );

    // O h1 continua existindo para leitor de tela, escondido do olho.
    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();

    const seletor = screen.getByRole("combobox", { name: "Trocar de funil: Vendas" });
    await userEvent.click(seletor);

    expect(await screen.findByRole("option", { name: "Vendas" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Suporte" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Parcerias" })).toBeTruthy();
  });

  it("escolher outro funil navega para o quadro dele, sem query string", async () => {
    render(
      <PipelinePageClient pipelineId="p-1" initialName="Vendas" funis={FUNIS} />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Trocar de funil: Vendas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Suporte" }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/app/pipelines/p-2");
  });

  it("a cor do funil (0371): ponto em cada opção colorida e no título; sem cor, nenhum", async () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        initialColor="#378ADD"
        funis={[
          { id: "p-1", name: "Vendas", color: "#378ADD" },
          { id: "p-2", name: "Suporte", color: "#D4537E" },
          { id: "p-3", name: "Parcerias", color: null },
        ]}
      />,
    );
    // O título (o gatilho do seletor) repete o conteúdo da opção escolhida.
    const seletor = screen.getByRole("combobox", { name: "Trocar de funil: Vendas" });
    expect(seletor.querySelector('[data-testid="ponto-do-funil"]')).not.toBeNull();

    await userEvent.click(seletor);
    const suporte = await screen.findByRole("option", { name: "Suporte" });
    expect(suporte.querySelector<HTMLElement>('[data-testid="ponto-do-funil"]')?.style.backgroundColor).toBeTruthy();
    expect(screen.getByRole("option", { name: "Parcerias" }).querySelector('[data-testid="ponto-do-funil"]')).toBeNull();
  });

  it("com um funil só e com cor, o ponto vai no h1", () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        initialColor="#639922"
        funis={[{ id: "p-1", name: "Vendas", color: "#639922" }]}
      />,
    );
    const titulo = screen.getByRole("heading", { name: "Vendas" });
    expect(titulo.getAttribute("data-cor-do-funil")).toBe("#639922");
    expect(titulo.querySelector('[data-testid="ponto-do-funil"]')).not.toBeNull();
  });

  it("escolher o funil atual não navega", async () => {
    render(
      <PipelinePageClient pipelineId="p-1" initialName="Vendas" funis={FUNIS} />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Trocar de funil: Vendas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Vendas" }));

    expect(push).not.toHaveBeenCalled();
  });
});
