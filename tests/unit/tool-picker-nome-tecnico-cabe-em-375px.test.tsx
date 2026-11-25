/**
 * O nome técnico de uma capacidade (`crm_start_conversation_and_send`) é uma
 * palavra só, sem ponto de quebra. Na lista do modo avançado ele empurrava a
 * ficha para fora da lista num celular de 375px no upstream (#5067:
 * `scrollWidth` 307 contra `clientWidth` 259), porque a coluna de texto da
 * ficha não encolhe abaixo da palavra mais longa que contém.
 *
 * Neste fork a fonte do nome é a Inconsolata, mais estreita, e o catálogo não
 * tem o nome de 37 letras do upstream: medido no Chromium com o CSS compilado,
 * o nome mais longo daqui (31 letras) só passa da lista abaixo de ~215 px de
 * largura (207/200 a 200 px). A classe fica como prevenção.
 * Porte de melgarafael/DeskcommCRM#5138 (contribuição de @AyhamJo7).
 *
 * O jsdom não calcula layout, então este teste prende a classe que deixa o
 * nome quebrar.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { ToolPicker } from "@/app/app/ai/agents/[id]/_components/ToolPicker";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

const NOME_LONGO = "crm_start_conversation_and_send";
const CAPACIDADE = {
  id: NOME_LONGO,
  description: "x",
  category: "write",
  requires_role: "agent",
  requires_scope: "mcp:write",
  rotulo: "Iniciar conversa e enviar",
  explicacao: "x",
  o_que_toca: "Conversas",
  risco: "atencao",
  pacotes: [],
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockResolvedValue({ data: { tools: [CAPACIDADE] } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("ToolPicker — nome técnico no modo avançado", () => {
  it("o nome técnico quebra linha em vez de alargar a ficha", async () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={client}>
          <ToolPicker value={[]} onChange={() => {}} />
        </QueryClientProvider>
      </IdiomaProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("toggle-avancado")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-avancado"));

    const ficha = screen
      .getByTestId("lista-avancada")
      .querySelector(`[data-testid="capacidade-${NOME_LONGO}"]`);
    const nome = Array.from(ficha?.querySelectorAll("code") ?? []).find(
      (el) => el.textContent === NOME_LONGO,
    );
    expect(nome).toBeTruthy();
    expect(nome!.classList.contains("break-all")).toBe(true);
  });
});
