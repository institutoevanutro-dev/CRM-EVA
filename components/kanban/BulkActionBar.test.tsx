/**
 * Perdido em lote no quadro (porte do upstream #2868, fatia F2 de #2484).
 *
 * A barra reusa o MESMO diálogo de motivo do card e escreve pela `leads/bulk`
 * com UM motivo para os selecionados; a ação só existe onde o funil tem etapa
 * de perda, e sem motivo nada é escrito.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bulkMutateAsync = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { success: toastSuccess, warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false }),
  useActiveOrg: () => ({ orgId: "o1", role: "agent" }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), mutateAsync: bulkMutateAsync, isPending: false }),
}));
vi.mock("@/hooks/kanban/useMotivosDePerdaDoFunil", () => ({
  useMotivosDePerdaDoFunil: () => ["preço alto", "prazo curto"],
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { BulkActionBar } from "./BulkActionBar";

const SEM_PERDA = [{ id: "s1", name: "Novo", is_lost: false }] as never;
const COM_PERDA = [
  { id: "s1", name: "Novo", is_lost: false },
  { id: "s-perdido", name: "Perdido", is_lost: true },
] as never;

function montar(stages = COM_PERDA, onClear = vi.fn()) {
  render(
    <BulkActionBar
      selectedIds={["lead-1", "lead-2"]}
      stages={stages}
      pipelineId="p-1"
      tagsExistentes={[]}
      onClear={onClear}
    />,
  );
  return onClear;
}

beforeEach(() => {
  bulkMutateAsync.mockReset();
  bulkMutateAsync.mockResolvedValue({ data: { updated_count: 2 } });
  toastSuccess.mockReset();
});

describe("BulkActionBar: perdido em lote", () => {
  it("escolhe o motivo do funil e manda os ids e o motivo para a etapa de perda", async () => {
    const onClear = montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Marcar como perdido…" }));
    const caixa = await screen.findByRole("dialog");
    await user.click(within(caixa).getByRole("radio", { name: "preço alto" }));
    await user.click(within(caixa).getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(bulkMutateAsync).toHaveBeenCalledWith({
        action: "move",
        lead_ids: ["lead-1", "lead-2"],
        params: { stage_id: "s-perdido", lost_reason: "preço alto" },
      }),
    );
    expect(onClear).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("2 marcados como perdidos.");
  });

  it("sem motivo o Confirmar fica barrado e nada é escrito", async () => {
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Marcar como perdido…" }));
    const caixa = await screen.findByRole("dialog");
    expect(within(caixa).getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(bulkMutateAsync).not.toHaveBeenCalled();
  });

  it("funil sem etapa de perda: a ação não é oferecida", () => {
    montar(SEM_PERDA);
    expect(screen.queryByRole("button", { name: "Marcar como perdido…" })).toBeNull();
  });
});
