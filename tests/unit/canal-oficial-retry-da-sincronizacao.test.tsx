/**
 * O pedido do histórico falhou na conexão por coexistência: a tela oferece
 * "Tentar de novo" dentro das 24 h e, depois delas, diz que só refazendo o fluxo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { OfficialChannelState } from "@/hooks/channels/useOfficialChannel";

const mutate = vi.fn();
vi.mock("@/hooks/channels/useOfficialChannel", () => ({
  useCadastroIncorporado: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSincronizarCoexistencia: () => ({ mutate, isPending: false }),
}));
vi.mock("@/lib/channels/meta/cadastro-incorporado-cliente", () => ({
  carregarSdk: async () => undefined,
  sdkPronto: () => true,
  abrirCadastroIncorporado: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { CadastroIncorporado } from "@/components/connections/CadastroIncorporado";

const horasAtras = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
function estado(historico: { request_id: string } | { erro: string } | null, onboardingEm: string): OfficialChannelState {
  return {
    connected: true, hasToken: true, phoneNumberId: "111222333", wabaId: "222333444555", displayName: "Clínica",
    phoneNumber: "+5527999049879", status: "WORKING", webhook: null,
    cadastroIncorporado: { disponivel: true, appId: "1234567890", configId: "cfg", versao: "v23.0", faltam: [], configurarEm: null },
    coexistencia: { onboarding_em: onboardingEm, pedidos: { contatos: { request_id: "c-1" }, historico }, historico: null },
  };
}

afterEach(cleanup);

describe("CadastroIncorporado — retry do pedido de histórico", () => {
  it("erro dentro das 24 h: aviso com botão que chama /sincronizar", () => {
    render(<CadastroIncorporado estado={estado({ erro: "x" }, horasAtras(2))} />);
    expect(screen.getByTestId("historico-nao-pedido").textContent).toContain("Importação do histórico não foi pedida.");
    fireEvent.click(screen.getByTestId("btn-sincronizar"));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("erro depois das 24 h: sem botão, manda refazer o fluxo", () => {
    render(<CadastroIncorporado estado={estado({ erro: "x" }, horasAtras(25))} />);
    expect(screen.queryByTestId("btn-sincronizar")).toBeNull();
    expect(screen.getByTestId("historico-fora-do-prazo")).toBeTruthy();
  });

  it("pedido aceito: nenhum aviso", () => {
    render(<CadastroIncorporado estado={estado({ request_id: "h-1" }, horasAtras(2))} />);
    expect(screen.queryByTestId("historico-nao-pedido")).toBeNull();
    expect(screen.queryByTestId("historico-fora-do-prazo")).toBeNull();
  });
});
