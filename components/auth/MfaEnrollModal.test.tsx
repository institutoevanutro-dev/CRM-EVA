/**
 * LIGAR A VERIFICAÇÃO EM DUAS ETAPAS NÃO PODE PARAR EM "GERANDO QR CODE".
 *
 * Sem resposta de `enrollMfa`, o passo do QR ficava em "Gerando QR code..."
 * sem nenhum botão: a pessoa não tinha como sair. Estourado o teto, o modal
 * volta ao passo inicial, como no ramo `!res.ok`, e diz o que aconteceu.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MfaEnrollModal } from "./MfaEnrollModal";
import { TETO_DA_ESPERA_MS } from "./teto-da-espera";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/app/actions/auth/enrollMfa", () => ({ enrollMfa: vi.fn() }));
vi.mock("@/app/actions/auth/confirmMfaEnroll", () => ({ confirmMfaEnroll: vi.fn() }));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: vi.fn() }));

const { enrollMfa } = await import("@/app/actions/auth/enrollMfa");

describe("MfaEnrollModal — a espera tem teto", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(enrollMfa).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("volta ao passo inicial e explica, quando o início da configuração não responde", async () => {
    vi.mocked(enrollMfa).mockImplementation(() => new Promise(() => {}));

    render(<MfaEnrollModal motivo="escolha" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Iniciar configuração" }));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("Gerando QR code...")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TETO_DA_ESPERA_MS + 500);
    });

    expect(screen.queryByText("Gerando QR code...")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não recebemos a resposta do servidor. Recarregue a página para tentar de novo.",
    );
    expect(screen.getByRole("button", { name: "Iniciar configuração" })).toBeEnabled();
  });
});

/**
 * Auditoria de 17/11, item 56: a janela obrigatória cobria a tela sem rolagem e
 * sem "Sair" — com o teclado aberto o botão sumia, e quem entrou com a conta
 * errada não tinha saída.
 */
describe("MfaEnrollModal — obrigatório tem rolagem e saída", () => {
  it("o fundo rola e há \"Sair\" quando a empresa exige", () => {
    render(<MfaEnrollModal />);
    expect(screen.getByRole("dialog").className).toMatch(/\boverflow-y-auto\b/);
    expect(screen.getByRole("button", { name: "Sair" })).toBeInTheDocument();
  });

  it("CONTROLE — ligado por escolha (Configurações), sem \"Sair\"", () => {
    render(<MfaEnrollModal motivo="escolha" />);
    expect(screen.queryByRole("button", { name: "Sair" })).toBeNull();
  });
});
