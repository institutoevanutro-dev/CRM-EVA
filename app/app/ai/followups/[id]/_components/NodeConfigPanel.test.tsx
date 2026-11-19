/**
 * O botão de excluir mora na casca do painel, não em cada formulário — um
 * único lugar cobre os 8 tipos. O loop abaixo é a prova de que nenhum tipo
 * troca o painel por outra casca e perde o botão.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NODE_TYPES } from "@/lib/followup/graph-schema";
import type { RFNode } from "@/lib/followup/graph-mappers";

import { NodeConfigPanel } from "./NodeConfigPanel";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
}));

function noDe(type: (typeof NODE_TYPES)[number]): RFNode {
  const visual = NODE_VISUALS[type];
  return {
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    data: { label: visual.defaultLabel, config: visual.defaultConfig() },
  };
}

function montar(type: (typeof NODE_TYPES)[number], onDelete = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NodeConfigPanel node={noDe(type)} onChange={() => {}} onDelete={onDelete} />
    </QueryClientProvider>,
  );
  return onDelete;
}

describe("NodeConfigPanel — excluir bloco", () => {
  it.each(NODE_TYPES)("oferece Excluir bloco para o tipo %s e só apaga depois de confirmar", async (type) => {
    const onDelete = montar(type);
    const botao = screen.getByTestId("delete-node");
    expect(botao).toHaveTextContent("Excluir bloco");
    const user = userEvent.setup({ delay: null });
    await user.click(botao);
    expect(onDelete).not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByRole("button", { name: "Excluir" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
