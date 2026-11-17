/**
 * A PÁGINA DO FUNIL (auditoria 16/11, achados 7, 25 e 32).
 *
 *  7.  "Salvar e iniciar conversa" criava o negócio e não abria a conversa: a
 *      página montava o diálogo só enquanto aberto, e o pedido de abrir — que
 *      mora no diálogo e roda DEPOIS de ele fechar — morria junto. O teste de
 *      `NewLeadDialog.iniciar-conversa` não pegava porque o arnês dele mantém
 *      o diálogo montado; aqui quem monta é a página de verdade.
 * 25.  A seleção sobrevivia à troca de filtro, e a barra agia sobre cards
 *      escondidos.
 * 28.  A altura do quadro não descontava a faixa de aviso do topo.
 * 32.  O botão dizia "Novo Lead" num funil que chama o negócio de Paciente.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PipelinePageClient } from "./_client";

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

const push = vi.hoisted(() => vi.fn());
const estado = vi.hoisted(() => ({ q: "", vocabulary: null as null | Record<string, string> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push, refresh: vi.fn() }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(estado.q ? { q: estado.q } : {}),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, role: "agent", orgId: "org-1" }),
  useAuth: () => ({ user: { id: "usuario-eu" } }),
  useUser: () => ({ id: "usuario-eu" }),
  usePermission: () => true,
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useFechadosAntigos: () => ({ data: undefined, isLoading: false }),
  useBoard: () => ({
    data: {
      pipeline: { id: FUNIL, name: "Clínica", vocabulary: estado.vocabulary, settings: null },
      stages: [
        { id: ETAPA, name: "Novo", position: 0, is_won: false, is_lost: false, is_archived: false },
      ],
      leads: [
        { id: "l-ana", title: "Ana Reis", stage_id: ETAPA, tags: [], position_in_stage: 1000 },
        { id: "l-bruno", title: "Bruno Sá", stage_id: ETAPA, tags: [], position_in_stage: 2000 },
      ],
    },
    isLoading: false,
    error: null,
    pulses: new Map(),
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/KanbanBoard", () => ({
  BoardSkeleton: () => null,
  KanbanBoard: ({ onSelectionChange }: { onSelectionChange: (ids: string[]) => void }) => (
    <button onClick={() => onSelectionChange(["l-ana", "l-bruno"])}>marcar os dois</button>
  ),
}));
vi.mock("@/components/kanban/BulkActionBar", () => ({
  BulkActionBar: ({ selectedIds }: { selectedIds: string[] }) => (
    <output data-testid="lote">{selectedIds.join(",")}</output>
  ),
}));

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

function montar(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ui: ReactNode = <PipelinePageClient pipelineId={FUNIL} initialName="Clínica" funis={[{ id: FUNIL, name: "Clínica" }]} />;
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  push.mockReset();
  estado.q = "";
  estado.vocabulary = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const caminho = String(url);
      if (caminho.includes("/api/v1/contacts") && init?.method === "POST")
        return resposta(
          { data: { contact: { id: CONTATO, name: "Joana Prado", phone_number: "+5511987654321" }, action: "created" } },
          201,
        );
      if (caminho.includes("/api/v1/leads")) return resposta({ data: { id: "l-novo", contact_id: CONTATO } }, 201);
      if (caminho.includes("/open-with-contact")) return resposta({ data: { conversation_id: "conv-7" } });
      if (caminho.endsWith("/claim")) return resposta({ data: {} });
      return resposta({ data: [] });
    }),
  );
});

describe("página do funil", () => {
  it("⭐ 'Salvar e iniciar conversa' abre a conversa mesmo com o diálogo fechando (achado 7)", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("button", { name: "Novo Lead" }));
    await user.type(screen.getByLabelText("Título"), "Joana Prado");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));
    const cadastro = screen.getByRole("dialog", { name: "Novo contato" });
    await user.type(within(cadastro).getByLabelText(/Telefone/i), "+5511987654321");
    await user.click(within(cadastro).getByRole("button", { name: "Criar contato" }));
    await screen.findByText("Joana Prado");

    await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/inbox?id=conv-7"));
  });

  it("a seleção em lote só leva o que o filtro deixa na tela (achado 25)", async () => {
    const user = userEvent.setup();
    const { rerender } = montar();
    await user.click(screen.getByRole("button", { name: "marcar os dois" }));
    expect(screen.getByTestId("lote")).toHaveTextContent("l-ana,l-bruno");

    estado.q = "Ana";
    const qc = new QueryClient();
    rerender(
      <QueryClientProvider client={qc}>
        <PipelinePageClient pipelineId={FUNIL} initialName="Clínica" funis={[{ id: FUNIL, name: "Clínica" }]} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("lote").textContent).toBe("l-ana");
  });

  it("o botão de criar fala o vocabulário do funil (achado 32)", async () => {
    estado.vocabulary = { lead: "Paciente" };
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("button", { name: "Adicionar paciente" }));
    expect(await screen.findByRole("dialog", { name: "Adicionar paciente" })).toBeVisible();
  });

  it("a altura do quadro desconta a faixa de aviso do topo, como o Inbox (achado 28)", () => {
    const { container } = montar();
    const quadro = container.querySelector<HTMLElement>("[data-realtime-status]");
    expect(quadro?.className).toContain("100dvh-var(--faixas-de-cima,0px)");
  });
});
