/**
 * Empate de posição entre dois cards visíveis cancelava o arrasto sem aviso:
 * `midpoint(1000, 1000)` é NaN e o quadro só fazia `return` (achado 27 da
 * auditoria de 16/11). Mesmo arnês de `arrastar-le-o-updated-at-do-cache`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { BoardData } from "@/lib/kanban/types";

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const capturado = vi.hoisted(() => ({
  onDragEnd: null as ((r: unknown) => void) | null,
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({
    onDragEnd,
    children,
  }: {
    onDragEnd: (r: unknown) => void;
    children: ReactNode;
  }) => {
    capturado.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
}));
vi.mock("@/components/kanban/StageColumn", () => ({ StageColumn: () => null }));
vi.mock("@/components/kanban/LeadDossier", () => ({ LeadDossier: () => null }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: null }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => undefined,
}));
// O GET do board fica PENDENTE de propósito: a janela do #916 é justamente o
// intervalo entre a resposta do move e o refetch do `onSettled` chegar. Um GET
// que responde fecha essa janela e o teste passaria a medir o refetch.
vi.mock("@/lib/api/client", () => ({
  apiClient: { post, patch, get: vi.fn(() => new Promise<never>(() => {})) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo, success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { KanbanBoard } from "@/components/kanban/KanbanBoard";

const PIPELINE = "p-1";
const lead = (id: string, pos: number) =>
  ({ id, stage_id: "s-1", position_in_stage: pos, updated_at: "2026-11-16T12:00:00.000Z" }) as BoardData["leads"][number];

describe("arrastar entre dois cards empatados (auditoria 16/11, achado 27)", () => {
  it("não cancela: grava uma posição livre e avisa", async () => {
    post.mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // A e B empatados em 1000 (dado antigo); Z é arrastado do fim para entre os dois.
    qc.setQueryData(["board", PIPELINE], {
      pipeline: { id: PIPELINE, settings: null },
      stages: [{ id: "s-1", name: "Novo", position: 0 }],
      leads: [lead("a", 1000), lead("b", 1000), lead("z", 5000)],
    } as unknown as BoardData);
    render(
      <QueryClientProvider client={qc}>
        <KanbanBoard pipelineId={PIPELINE} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());

    await act(async () => {
      capturado.onDragEnd?.({
        draggableId: "z",
        source: { droppableId: "s-1", index: 2 },
        destination: { droppableId: "s-1", index: 1 },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const corpo = post.mock.calls[0]![1] as { position_in_stage: number };
    expect(Number.isFinite(corpo.position_in_stage)).toBe(true);
    expect([1000, 5000]).not.toContain(corpo.position_in_stage);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });
});
