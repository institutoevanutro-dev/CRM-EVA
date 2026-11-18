/**
 * Item 40 da auditoria de 17/11: com o mouse sobre a lista, mensagem nova não
 * reordena as linhas (o clique cairia em outra conversa). Um aviso "N conversas
 * com novidade" solta a ordem; tirar o mouse também.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/channels/useChannelSessions", () => ({ useChannelSessions: () => ({ data: [] }) }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: false }) }));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({ conversation }: { conversation: { id: string } }) => (
    <div data-testid="linha">{conversation.id}</div>
  ),
}));

import { ConversationList } from "@/components/inbox/ConversationList";

type Consulta = React.ComponentProps<typeof ConversationList>["listQuery"];
const consulta = (...ids: string[]) =>
  ({ data: { pages: [{ data: ids.map((id) => ({ id })) }] }, isLoading: false, isError: false }) as unknown as Consulta;

function montar(q: Consulta) {
  const props = { filters: {}, selectedId: null, onSelect: vi.fn() };
  const r = render(<ConversationList listQuery={q} {...props} />);
  return (nova: Consulta) => r.rerender(<ConversationList listQuery={nova} {...props} />);
}
const ordem = () => screen.getAllByTestId("linha").map((l) => l.textContent);

describe("item 40 — a lista não pula sob o mouse", () => {
  it("⭐ mouse em cima: a nova ordem espera; o aviso solta", () => {
    const trocar = montar(consulta("ana", "bruno", "carla"));
    const rolagem = screen.getAllByTestId("linha")[0]!.parentElement!;
    fireEvent.pointerEnter(rolagem, { pointerType: "mouse" });

    trocar(consulta("carla", "ana", "bruno"));
    expect(ordem()).toEqual(["ana", "bruno", "carla"]);

    fireEvent.click(screen.getByRole("button", { name: "1 conversa com novidade" }));
    expect(ordem()).toEqual(["carla", "ana", "bruno"]);
  });

  it("sem mouse em cima, a lista segue a ordem nova na hora", () => {
    const trocar = montar(consulta("ana", "bruno"));
    trocar(consulta("bruno", "ana"));
    expect(ordem()).toEqual(["bruno", "ana"]);
  });
});
