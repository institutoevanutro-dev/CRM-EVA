import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { RiskRadarList } from "./RiskRadarList";

// Item 195: a lista diz "N de total" e pede mais; a demanda sem próximo passo
// conta pelo servidor e abre o contato. Item 196: "Ver compromisso" é botão.
const lead = (i: number) => ({
  id: `l-${i}`,
  title: `Avaliação ${i}`,
  contact_id: null,
  contact_name: null,
  owner_user_id: "u-1",
  owner_kind: "user",
  owner_agent_id: null,
  owner_agent_name: null,
  assignee_kind: "user",
  last_activity_at: null,
  hours_since_activity: 80,
  risk: "critico",
  in_flight: false,
  next_followup_at: null,
  conversation_id: null,
  pipeline_id: "p-1",
  ...(i === 0 ? { agenda: { appointment_id: "ap-1", motivo: "agendado" } } : {}),
});

function dublarFetch() {
  const spy = vi.fn(async (url: string) => {
    const limite = Number(new URL(url, "http://x").searchParams.get("limit"));
    const corpo = {
      data: {
        items: Array.from({ length: Math.min(limite, 3) }, (_, i) => lead(i)),
        counts: { critico: 120, em_risco: 0, em_voo: 0 },
        total: limite >= 200 ? 3 : 120,
        sem_proximo_passo: [{ id: "d-1", contact_id: "c-1", contact_name: "Paciente Exemplo", aberta_em: "2026-11-01T00:00:00Z", horas_aberta: 30, origem: "x" }],
        total_sem_proximo_passo: 73,
        recomecado_em: null,
      },
    };
    return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RiskRadarList", () => {
  it("diz quantos de quantos, pede mais ao servidor e as linhas abrem", async () => {
    const fetch = dublarFetch();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RiskRadarList />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("73 demandas abertas sem próximo passo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Paciente Exemplo/ })).toHaveAttribute("href", "/app/contacts/c-1");
    expect(screen.getByTestId("radar-mostrando")).toHaveTextContent("Mostrando 3 de 120");
    expect(screen.getByRole("link", { name: "Ver compromisso" })).toHaveAttribute("href", "/app/agenda?compromisso=ap-1");
    fireEvent.click(screen.getByRole("button", { name: "Ver mais" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("limit=200"), expect.anything()));
  });
});
