/**
 * O cartão do Jev: o aviso da área da saúde aparece sempre (#2085); sem chave,
 * diz que nada sai; com chave e sem aceite, o interruptor só liga depois de o
 * administrador marcar o aceite, e o pedido leva `aceitar: true`.
 *
 * Estados por tarefa: três nos dois pedidos do cliente, dois no clima; "Avisar
 * a equipe" só vale depois da confirmação; voltar a observar é um clique; e o
 * contador de avisos aparece ao lado dos de observação.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CartaoDoJev } from "./CartaoDoJev";

const vazio = { observadas: 0, comPar: 0, concordou: 0, percebidas: 0, avisos: 0, latenciaMediaMs: null };
const DOIS = ["observando", "desligada"];
const TRES = ["observando", "decidindo", "desligada"];
const base = {
  chaveConfigurada: false,
  modelo: "jev-1.13.0",
  ligado: false,
  aceite: null,
  tarefas: [
    { id: "clima", estado: "desligada", estados: DOIS },
    { id: "humano", estado: "desligada", estados: TRES },
    { id: "opt_out", estado: "desligada", estados: TRES },
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

describe("CartaoDoJev: estados por tarefa", () => {
  const resumo = (avisos: number) => ({ observadas: 12, comPar: 0, concordou: 0, percebidas: 3, avisos, latenciaMediaMs: 310 });
  let estadoDoOptOut: string;
  let pedidos: Array<Record<string, unknown>>;

  beforeEach(() => {
    estadoDoOptOut = "observando";
    pedidos = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          const corpo = JSON.parse(String(init.body)) as { tarefas?: { opt_out?: string } };
          pedidos.push(corpo);
          estadoDoOptOut = corpo.tarefas?.opt_out ?? estadoDoOptOut;
          return new Response(JSON.stringify({ data: {} }), { status: 200 });
        }
        const dados = {
          ...base,
          chaveConfigurada: true,
          ligado: true,
          aceite: { em: "2026-10-12T12:00:00.000Z", por: "u" },
          tarefas: [
            { id: "clima", estado: "observando", estados: DOIS },
            { id: "humano", estado: "observando", estados: TRES },
            { id: "opt_out", estado: estadoDoOptOut, estados: TRES },
          ],
          resumo: { clima: resumo(0), humano: resumo(0), opt_out: resumo(2) },
        };
        return new Response(JSON.stringify({ data: dados }), { status: 200 });
      }),
    );
  });

  const botoes = (nome: string) =>
    within(screen.getByRole("group", { name: nome }))
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("três estados nos pedidos, dois no clima, e o contador de avisos só nos pedidos", async () => {
    render(<CartaoDoJev />);
    await screen.findByTestId("cartao-do-jev");
    expect(botoes("Pedido para parar de receber mensagens")).toEqual(["Observando", "Avisar a equipe", "Desligada"]);
    expect(botoes("Pedido para falar com uma pessoa")).toEqual(["Observando", "Avisar a equipe", "Desligada"]);
    expect(botoes("Clima da conversa")).toEqual(["Observando", "Desligada"]);

    const cartao = screen.getByTestId("cartao-do-jev").textContent ?? "";
    expect(cartao).toContain("12 observadas · 3 pedidos que a regra não reconheceu · 2 avisos à equipe");
    expect(cartao).toContain("12 observadas · 3 vistas como reclamação · 310 ms");
  });

  it("avisar a equipe só vale depois de confirmar; voltar a observar é um clique", async () => {
    const user = userEvent.setup();
    render(<CartaoDoJev />);
    await screen.findByTestId("cartao-do-jev");
    const linha = () => within(screen.getByRole("group", { name: "Pedido para parar de receber mensagens" }));

    await user.click(linha().getByRole("button", { name: "Avisar a equipe" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo.textContent).toContain("o Jev nunca bloqueia ninguém");
    expect(pedidos, "abrir o diálogo não grava nada").toEqual([]);
    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    expect(pedidos).toEqual([]);

    await user.click(linha().getByRole("button", { name: "Avisar a equipe" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Avisar a equipe" }));
    expect(pedidos).toEqual([{ tarefas: { opt_out: "decidindo" } }]);

    await waitFor(() => expect(linha().getByRole("button", { name: "Avisar a equipe" }).getAttribute("aria-pressed")).toBe("true"));
    await user.click(linha().getByRole("button", { name: "Observando" }));
    expect(pedidos[1]).toEqual({ tarefas: { opt_out: "observando" } });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
