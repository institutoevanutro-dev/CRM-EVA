/** Barra de progresso do histórico na aba do canal oficial. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { OfficialChannelState } from "@/hooks/channels/useOfficialChannel";

vi.mock("@/hooks/channels/useOfficialChannel", () => ({
  useCadastroIncorporado: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSincronizarCoexistencia: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { CadastroIncorporado } from "@/components/connections/CadastroIncorporado";

function estado(historico: NonNullable<OfficialChannelState["coexistencia"]>["historico"]): OfficialChannelState {
  return {
    connected: true,
    hasToken: true,
    phoneNumberId: "1",
    wabaId: "2",
    displayName: "Clínica",
    phoneNumber: null,
    status: "WORKING",
    webhook: null,
    cadastroIncorporado: { disponivel: true, appId: "a", configId: "c", versao: "v25.0", faltam: [], configurarEm: null },
    coexistencia: {
      onboarding_em: new Date().toISOString(),
      pedidos: { contatos: { request_id: "r" }, historico: { request_id: "r" } },
      historico,
    },
  };
}

afterEach(cleanup);

describe("CadastroIncorporado — progresso do histórico", () => {
  it("progresso 20: barra com value=20 e texto", () => {
    render(<CadastroIncorporado estado={estado({ fase: 1, progresso: 20, concluido: false, erro_codigo: null })} />);
    expect(screen.getByTestId("historico-progresso").textContent).toContain("Importando histórico… 20%");
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("20");
  });
  it("concluído", () => {
    render(<CadastroIncorporado estado={estado({ fase: 2, progresso: 100, concluido: true, erro_codigo: null })} />);
    expect(screen.getByTestId("historico-progresso").textContent).toContain("Histórico importado.");
  });
  it("erro 2593109: frase da Meta", () => {
    render(<CadastroIncorporado estado={estado({ fase: null, progresso: null, concluido: false, erro_codigo: 2593109 })} />);
    expect(screen.getByTestId("historico-erro").textContent).toContain("não compartilhou o histórico");
    expect(screen.queryByTestId("historico-progresso")).toBeNull();
  });
  it("erro desconhecido: frase padrão", () => {
    render(<CadastroIncorporado estado={estado({ fase: null, progresso: null, concluido: false, erro_codigo: 999 })} />);
    expect(screen.getByTestId("historico-erro").textContent).toContain("Não deu para importar o histórico.");
  });
});
