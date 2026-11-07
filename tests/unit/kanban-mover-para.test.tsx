import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";

/**
 * D1.5: mudar a etapa sem arrastar (WCAG 2.5.7). O "Mover para" do menu ⋯ usa a
 * MESMA rota do arraste e põe o card no fim da etapa de destino, contado na
 * etapa inteira do cache do quadro.
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { post, get: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => chave === "pipeline.move_card",
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

const etapa = (id: string, name: string, color: string | null = null) =>
  ({ id, name, color }) as unknown as Stage;
const STAGES = [etapa("s-1", "Novo", "#3b6692"), etapa("s-2", "Avaliação"), etapa("s-3", "Fechado")];

const LEAD = {
  id: "l-1",
  title: "Paciente Fictícia",
  stage_id: "s-1",
  position_in_stage: 1000,
  updated_at: "2026-11-06T10:00:00Z",
  owner_user_id: null,
  owner_agent_id: null,
} as unknown as Lead;

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(chaveDoQuadro("p-1"), {
    pipeline: {},
    stages: STAGES,
    leads: [
      LEAD,
      { id: "l-2", stage_id: "s-2", position_in_stage: 3000 },
      { id: "l-3", stage_id: "s-2", position_in_stage: 5000 },
    ],
  });
  return render(
    <QueryClientProvider client={client}>
      <KanbanCardActions lead={LEAD} pipelineId="p-1" stages={STAGES} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ data: { ...LEAD, stage_id: "s-2" } });
});

describe("menu do card — Mover para", () => {
  it("lista as etapas, desabilita a atual e move para o fim da escolhida", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mover para" }));

    const atual = await screen.findByRole("menuitem", { name: "Novo" });
    expect(atual.getAttribute("aria-disabled")).toBe("true");

    screen.getByRole("menuitem", { name: "Avaliação" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/leads/l-1/move", {
      stage_id: "s-2",
      position_in_stage: 6000,
      expected_updated_at: "2026-11-06T10:00:00Z",
    });
  });

  it("sem etapas, o item não aparece", async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <KanbanCardActions lead={LEAD} pipelineId="p-1" />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
    await screen.findByRole("menuitem", { name: "Editar" });
    expect(screen.queryByRole("menuitem", { name: "Mover para" })).toBeNull();
  });
});
