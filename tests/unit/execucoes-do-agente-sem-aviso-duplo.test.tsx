/**
 * EXECUÇÕES DO AGENTE: SEM AVISO DUPLO, EM PORTUGUÊS, COM "VER MAIS"
 * (auditoria de 17/11, lote 1, item 12).
 *
 * Cada mensagem de paciente gerava dois avisos ("Nova execução iniciada." e
 * "Execução concluída."), a falha chegava como "Execução failed", o selo da
 * lista mostrava "completed"/"failed", e a lista parava nas 25 mais recentes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const AGENTE = "44444444-4444-4444-8444-444444444444";

const api = vi.hoisted(() => ({ get: vi.fn() }));
const canal = vi.hoisted(() => ({ onChange: null as null | ((p: unknown) => void) }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { onChange: (p: unknown) => void }) => {
    canal.onChange = opts.onChange;
  },
}));

import { toast } from "sonner";

import { RunsTable } from "@/app/app/ai/agents/[id]/_components/RunsTable";

function execucao(id: string, status: string, inicio: string) {
  return {
    id,
    organization_id: "org",
    agent_id: AGENTE,
    agent_version_id: null,
    conversation_id: null,
    contact_id: null,
    channel_session_id: null,
    inbound_message_id: null,
    outbound_message_id: null,
    status,
    abort_reason: null,
    error_code: null,
    error_message: null,
    tokens_in: 10,
    tokens_out: 5,
    cost_cents: 1,
    latency_ms: 900,
    steps_count: null,
    tool_calls: null,
    is_dry_run: false,
    started_at: inicio,
    completed_at: inicio,
    created_at: inicio,
  };
}

function abrir() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RunsTable agentId={AGENTE} active />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  canal.onChange = null;
  api.get.mockImplementation((caminho: string) =>
    Promise.resolve(
      caminho.includes("cursor=")
        ? { data: [execucao("e3", "completed", "2026-11-17T08:00:00Z")], meta: { cursor: null, has_more: false } }
        : {
            data: [
              execucao("e1", "completed", "2026-11-17T10:00:00Z"),
              execucao("e2", "failed", "2026-11-17T09:00:00Z"),
            ],
            meta: { cursor: "cursor-da-pagina-2", has_more: true },
          },
    ),
  );
});

describe("aba Execuções", () => {
  it("execução nova ou concluída não vira aviso na tela — a lista se atualiza sozinha", async () => {
    abrir();
    await screen.findByText("Concluída");
    expect(canal.onChange, "a aba deixou de ouvir as execuções ao vivo").not.toBeNull();

    canal.onChange!({ eventType: "INSERT", new: { status: "running", is_dry_run: false } });
    canal.onChange!({ eventType: "UPDATE", new: { status: "completed" } });
    canal.onChange!({ eventType: "UPDATE", new: { status: "failed" } });

    expect(toast.info, "cada mensagem de paciente gerava dois avisos").not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error, "'Execução failed' chegava em inglês").not.toHaveBeenCalled();
    // A atualização continua: o aviso saiu, a recarga da lista ficou.
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(1));
  });

  it("a situação aparece em português", async () => {
    abrir();
    expect(await screen.findByText("Concluída")).toBeInTheDocument();
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
    expect(screen.queryByText("failed")).not.toBeInTheDocument();
  });

  it("'Ver mais' traz a página seguinte pelo cursor da rota", async () => {
    const user = userEvent.setup();
    abrir();
    await user.click(await screen.findByRole("button", { name: "Ver mais" }));

    await waitFor(() => expect(screen.getAllByText("Concluída")).toHaveLength(2));
    expect(api.get).toHaveBeenCalledWith(
      `/api/v1/ai/agents/${AGENTE}/runs?limit=25&cursor=cursor-da-pagina-2`,
    );
    expect(screen.queryByRole("button", { name: "Ver mais" })).not.toBeInTheDocument();
  });
});
