/**
 * A COR DO FUNIL NA TELA (migration 0371).
 *
 * Três lugares mostram a cor: a linha da lista de Funis (barra à esquerda,
 * fundo tingido e o ponto ao lado do nome), o seletor rápido do título do
 * quadro (o ponto em cada opção) e o cabeçalho do quadro. Funil sem cor fica
 * exatamente como era — sem estilo, sem ponto.
 *
 * A cor se escolhe com o MESMO seletor da etapa, aberto pelo item "Cor do funil"
 * do menu "⋯" ou pelo gatilho da linha, e grava pelo PATCH do funil.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FunisClient, type FunilDaLista } from "@/app/app/kanban/_client";

const mocks = vi.hoisted(() => ({ editar: vi.fn() }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Clínica", role: "manager", cliente_pela_agenda: false }),
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: "manager" } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useCriarFunil: () => ({ isPending: false, mutate: vi.fn() }),
  useEditarFunil: () => ({ isPending: false, mutate: mocks.editar }),
  useArquivarFunil: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({ ImportarLeads: () => null }));

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const funil = (id: string, name: string, color: string | null): FunilDaLista => ({
  id,
  name,
  slug: id,
  description: null,
  position: 1,
  is_default: id === "f-azul",
  color,
});

const AZUL = funil("f-azul", "Atendimento", "#378ADD");
const SEM_COR = funil("f-sem", "Pós-venda", null);

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("a lista de Funis", () => {
  it("funil com cor: barra, fundo tingido e ponto; sem cor, nada muda", () => {
    render(comQuery(<FunisClient funis={[AZUL, SEM_COR]} arquivados={[]} podeGerenciar podeImportar={false} />));

    const colorido = screen.getByTestId("funil-f-azul");
    expect(colorido.style.boxShadow).toBe("inset 3px 0 0 #378ADD");
    expect(colorido.style.backgroundColor).toMatch(/^color-mix\(in srgb, (#378ADD|rgb\(55, 138, 221\))/);
    expect(screen.getByTestId("ponto-do-funil-f-azul").style.backgroundColor).toBeTruthy();

    const semCor = screen.getByTestId("funil-f-sem");
    expect(semCor.getAttribute("style")).toBeNull();
    expect(screen.queryByTestId("ponto-do-funil-f-sem")).toBeNull();
  });

  it("o item 'Cor do funil' do menu abre o seletor da linha, e escolher grava pelo PATCH", async () => {
    const user = userEvent.setup();
    render(comQuery(<FunisClient funis={[AZUL, SEM_COR]} arquivados={[]} podeGerenciar podeImportar={false} />));

    await user.click(screen.getByTestId("acoes-f-sem"));
    await user.click(await screen.findByTestId("cor-f-sem"));

    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText("Cor do funil")).toBeTruthy();
    await user.click(within(popover).getByRole("button", { name: "Rosa" }));

    expect(mocks.editar).toHaveBeenCalledWith(
      { id: "f-sem", patch: { color: "#D4537E" } },
      expect.anything(),
    );
  });

  it("'Sem cor' tira a cor", async () => {
    const user = userEvent.setup();
    render(comQuery(<FunisClient funis={[AZUL]} arquivados={[]} podeGerenciar podeImportar={false} />));
    await user.click(screen.getByRole("button", { name: "Cor do funil" }));
    await user.click(await screen.findByRole("button", { name: "Sem cor" }));
    expect(mocks.editar).toHaveBeenCalledWith({ id: "f-azul", patch: { color: null } }, expect.anything());
  });

  it("quem não gerencia vê a cor, mas não tem como mudá-la", () => {
    render(comQuery(<FunisClient funis={[AZUL]} arquivados={[]} podeGerenciar={false} podeImportar={false} />));
    expect(screen.getByTestId("ponto-do-funil-f-azul")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cor do funil" })).toBeNull();
    expect(screen.queryByTestId("acoes-f-azul")).toBeNull();
  });
});
