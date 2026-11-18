/**
 * A LISTA DE AGENTES MUDA DEPOIS DA AÇÃO (auditoria de 17/11, lote 1, item 3).
 *
 * Pausar, renomear, duplicar ou arquivar mostravam o aviso verde e o cartão
 * ficava igual — quem clicava de novo criava cópias repetidas. A lista vem do
 * cache do React Query (`useAgentsList`, com `staleTime` de 30 s), e o
 * `router.refresh()` do menu só trocava o `initialData`, que o cache ignora
 * depois do primeiro render.
 *
 * O QueryClient aqui é o de PRODUÇÃO (`makeQueryClient`): com o padrão do
 * TanStack (`staleTime: 0`) a lista se rebuscaria sozinha ao montar, e o teste
 * passaria sem o conserto.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
const acoes = vi.hoisted(() => ({ renomear: vi.fn(), duplicar: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/app/app/ai/agents/_actions", () => ({
  renameAgentAction: acoes.renomear,
  duplicateAgentAction: acoes.duplicar,
  pauseAgentAction: vi.fn(),
  unpauseAgentAction: vi.fn(),
  archiveAgentAction: vi.fn(),
}));

import { AgentsList } from "@/app/app/ai/agents/_components/AgentsList";
import { makeQueryClient } from "@/lib/query/client";
import type { AgentRow } from "@/hooks/ai/useAgent";

const CLARA = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "org-1",
  name: "Clara",
  description: null,
  model: "claude-sonnet-5",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  kind: "mcp_agent",
  priority: 0,
  published_version_id: "v1",
  paused_at: null,
  archived_at: null,
  config: {},
  guardrails: {},
  active_kb_version_id: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
} as unknown as AgentRow;

function abrirLista() {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <AgentsList initialData={[CLARA]} canWrite />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lista de agentes — o cartão reflete a ação", () => {
  it("renomear troca o nome no cartão, sem recarregar a página", async () => {
    const user = userEvent.setup();
    acoes.renomear.mockResolvedValue({ ok: true });
    api.get.mockResolvedValue({ data: [{ ...CLARA, name: "Clara da Recepção" }] });
    abrirLista();

    await user.click(screen.getByRole("button", { name: "Menu de ações" }));
    await user.click(await screen.findByRole("menuitem", { name: "Renomear" }));
    const dialogo = await screen.findByRole("dialog");
    const campo = within(dialogo).getByLabelText("Nome");
    await user.clear(campo);
    await user.type(campo, "Clara da Recepção");
    await user.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    // Por texto e não por papel: no jsdom o Radix deixa o fundo `aria-hidden`
    // depois do diálogo aberto a partir do menu, e o papel some da árvore.
    expect(
      await screen.findByText("Clara da Recepção", { selector: "h3" }),
      "o aviso verde apareceu e o cartão seguiu com o nome antigo",
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/ai/agents");
  });

  it("duplicar faz a cópia aparecer na lista", async () => {
    const user = userEvent.setup();
    acoes.duplicar.mockResolvedValue({ ok: true, data: { new_id: "c2" } });
    api.get.mockResolvedValue({
      data: [{ ...CLARA, id: "22222222-2222-4222-8222-222222222222", name: "Clara (cópia)" }, CLARA],
    });
    abrirLista();

    await user.click(screen.getByRole("button", { name: "Menu de ações" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicar" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Clara (cópia)" })).toBeInTheDocument(),
    );
  });
});
