/**
 * O CARD DO FUNIL: ARRASTAR PELO NOME, CAIXA NO TOQUE, RODAPÉ SEM ETAPA
 * (auditoria 16/11, achados 8, 30 e 31).
 *
 * 8.  O nome era um `<button>`, e o @hello-pangea/dnd ignora gesto que começa
 *     em elemento interativo. Quem pegava o card pelo nome — o lugar mais
 *     natural — abria o dossiê em vez de arrastar. A régua aqui é a MESMA lista
 *     de tags que a biblioteca consulta (`interactiveTagNames` no código dela):
 *     do nome até o handle não pode haver nenhuma.
 * 30. A caixa de seleção sumia por `opacity-0` puro e só voltava com hover. No
 *     iPhone e no iPad não há hover: a ação em lote ficava invisível.
 * 31. "em <etapa>" repetia em todo card o nome que está no topo da coluna, e a
 *     caixa invisível à esquerda recuava o título.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { describe, expect, it, vi } from "vitest";

import type { CardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/kanban/KanbanCardActions", () => ({
  KanbanCardActions: () => <button type="button">Ações do lead</button>,
}));

const { KanbanCard } = await import("@/components/kanban/KanbanCard");

const CARD: CardInput = {
  id: "lead-1",
  title: "Joana Prado",
  valueCents: null,
  currency: "BRL",
  owner: { kind: "user", name: "Bia Lemos", agentVersion: null },
  stageName: "Avaliação agendada",
  hoursInStage: 5,
  isCooling: false,
  tags: [],
};

/** As tags que o @hello-pangea/dnd trata como interativas (e onde não deixa arrastar). */
const TAGS_QUE_O_DND_BLOQUEIA = ["button", "input", "textarea", "select", "option", "optgroup", "video", "audio"];

function montar(onOpen = vi.fn(), onSelect = vi.fn()) {
  render(
    <DragDropContext onDragEnd={() => {}}>
      <Droppable droppableId="etapa-1">
        {(p) => (
          <div ref={p.innerRef} {...p.droppableProps}>
            <KanbanCard
              card={CARD}
              lead={{ id: "lead-1" } as Lead}
              index={0}
              pipelineId="funil-1"
              onOpen={onOpen}
              onSelect={onSelect}
            />
            {p.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>,
  );
  return { onOpen, onSelect };
}

describe("card do funil", () => {
  it("o nome não é elemento que o arrasto ignora (achado 8)", () => {
    montar();
    const nome = screen.getByRole("button", { name: "Joana Prado" });
    const handle = screen.getByRole("group", { name: "Lead: Joana Prado" });
    for (let el: HTMLElement | null = nome; el && el !== handle; el = el.parentElement) {
      expect(TAGS_QUE_O_DND_BLOQUEIA, `<${el.tagName.toLowerCase()}> entre o nome e o handle`).not.toContain(
        el.tagName.toLowerCase(),
      );
      expect(el.getAttribute("contenteditable")).toBeNull();
    }
  });

  it("o nome continua abrindo o dossiê pelo mouse e pelo Enter", () => {
    const { onOpen } = montar();
    const nome = screen.getByRole("button", { name: "Joana Prado" });
    expect(nome).toHaveAttribute("tabindex", "0");

    fireEvent.click(nome);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(nome, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("a caixa de seleção só se esconde onde existe hover (achado 30)", () => {
    montar();
    const caixa = screen.getByRole("checkbox", { name: "Selecionar: Joana Prado" });
    const classes = caixa.className.split(/\s+/);
    expect(classes).not.toContain("opacity-0");
    expect(classes).toContain("[@media(hover:hover)]:opacity-0");
  });

  it("o título vem antes da caixa, e o rodapé não repete a etapa (achado 31)", () => {
    montar();
    const nome = screen.getByRole("button", { name: "Joana Prado" });
    const caixa = screen.getByRole("checkbox", { name: "Selecionar: Joana Prado" });
    expect(nome.compareDocumentPosition(caixa) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("há 5h")).toBeInTheDocument();
    expect(screen.queryByText(/Avaliação agendada/)).toBeNull();
  });
});
