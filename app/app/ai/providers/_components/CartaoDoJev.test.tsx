/**
 * O cartão do Jev (fase 1): o aviso da área da saúde aparece sempre (#2085);
 * sem chave, diz que nada sai; com chave e sem aceite, o interruptor só liga
 * depois de o administrador marcar o aceite, e o pedido leva `aceitar: true`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CartaoDoJev } from "./CartaoDoJev";

const vazio = { observadas: 0, comPar: 0, concordou: 0, percebidas: 0, latenciaMediaMs: null };
const base = {
  chaveConfigurada: false,
  modelo: "jev-1.13.0",
  ligado: false,
  aceite: null,
  tarefas: [
    { id: "clima", estado: "desligada" },
    { id: "humano", estado: "desligada" },
    { id: "opt_out", estado: "desligada" },
  ],
  resumo: { clima: vazio, humano: vazio, opt_out: vazio },
  janelaDias: 30,
  podeEditar: true,
};

function servidor(dados: object) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "PATCH"
      ? new Response(JSON.stringify({ data: {} }), { status: 200 })
      : new Response(JSON.stringify({ data: dados }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("CartaoDoJev", () => {
  it("sem chave: aviso da saúde e a frase de que nada sai", async () => {
    servidor(base);
    render(<CartaoDoJev />);
    expect(await screen.findByText(/Área da saúde/)).toBeTruthy();
    expect(screen.getByText(/nenhuma mensagem sai para a TypeSafe/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("com chave: o interruptor espera o aceite e liga levando o aceite junto", async () => {
    const fetchMock = servidor({ ...base, chaveConfigurada: true });
    render(<CartaoDoJev />);
    const interruptor = await screen.findByRole("switch");
    expect(interruptor.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(interruptor);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(true));
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ ligado: true, aceitar: true });
  });
});
