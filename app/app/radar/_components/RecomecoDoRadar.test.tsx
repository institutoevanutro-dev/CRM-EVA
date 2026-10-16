import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { RecomecoDoRadar } from "./RecomecoDoRadar";

const RADAR_VAZIO = {
  items: [],
  counts: { critico: 0, em_risco: 0, em_voo: 0 },
  total: 0,
  sem_proximo_passo: [],
  total_sem_proximo_passo: 0,
};

function dublarFetch(recomecadoEm: string | null) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const corpo =
      url.includes("/recomeco")
        ? { data: { recomecado_em: init?.method === "DELETE" ? null : "2026-10-16T11:30:00.000Z" } }
        : { data: { ...RADAR_VAZIO, recomecado_em: recomecadoEm } };
    return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function montar(podeRecomecar: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecomecoDoRadar podeRecomecar={podeRecomecar} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("recomeçar o radar, na tela", () => {
  it("quem não é administrador não vê o botão; sem recomeço, não vê nada", async () => {
    const fetch = dublarFetch(null);
    const { container } = montar(false);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("radar-recomecar")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("todo mundo vê desde quando o radar conta; só o administrador desfaz", async () => {
    dublarFetch("2026-10-16T11:30:00.000Z");
    montar(false);
    expect(await screen.findByTestId("radar-recomecado-em")).toHaveTextContent(/Radar recomeçado em \d{2}\/10 às \d{2}:30/);
    expect(screen.queryByTestId("radar-desfazer-recomeco")).toBeNull();
  });

  it("o administrador confirma no diálogo, e só então a rota é chamada", async () => {
    const fetch = dublarFetch(null);
    montar(true);
    fireEvent.click(await screen.findByTestId("radar-recomecar"));
    const dialogo = await screen.findByTestId("radar-recomeco-dialogo");
    expect(dialogo).toHaveTextContent("Nada é apagado");
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/recomeco"))).toBe(false);

    fireEvent.click(screen.getByTestId("radar-recomeco-confirmar"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) => String(url).includes("/api/v1/leads/at-risk/recomeco") && init?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("desfazer pede confirmação e chama o DELETE", async () => {
    const fetch = dublarFetch("2026-10-16T11:30:00.000Z");
    montar(true);
    fireEvent.click(await screen.findByTestId("radar-desfazer-recomeco"));
    expect(await screen.findByTestId("radar-recomeco-dialogo")).toHaveTextContent("voltam a aparecer");
    fireEvent.click(screen.getByTestId("radar-recomeco-confirmar"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url, init]) => String(url).includes("/recomeco") && init?.method === "DELETE"),
      ).toBe(true),
    );
  });
});
