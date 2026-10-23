/**
 * Configurações › Segurança: gerar códigos de recuperação sem o código de 6
 * dígitos provado nesta sessão (`mfa_required`) leva ao desafio e volta para
 * cá, em vez de mostrar "Erro: mfa_required".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const regenerar = vi.hoisted(() => vi.fn());
const navegar = vi.fn();
const toastErro = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/settings/regenerateRecoveryCodes", () => ({ regenerateRecoveryCodes: regenerar }));
vi.mock("@/app/actions/settings/signOutEverywhere", () => ({ signOutEverywhere: vi.fn() }));
vi.mock("@/app/actions/auth/politicaDeMfa", () => ({
  definirExigenciaDeMfa: vi.fn(),
  desativarMfaDaConta: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastErro } }));
vi.mock("@/components/auth/RecoveryCodesPanel", () => ({ RecoveryCodesPanel: () => null }));
vi.mock("@/components/auth/MfaEnrollModal", () => ({ MfaEnrollModal: () => null }));
vi.mock("@/components/voice/PainelDeChamadaDeVoz", () => ({ PainelDeChamadaDeVoz: () => null }));

// `window.location` não é redefinível no jsdom: o mesmo desvio de
// tests/unit/onboarding-tem-saida.test.tsx.
const realWindow = window;
vi.stubGlobal(
  "window",
  new Proxy(realWindow, {
    get(target, property) {
      if (property === "location") return { ...target.location, assign: navegar };
      return Reflect.get(target, property, target);
    },
  }),
);
vi.stubGlobal("confirm", () => true);

import { SecurityClient } from "./_client";

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  navegar.mockClear();
  toastErro.mockClear();
});

function regenerarNaTela() {
  render(<SecurityClient mfaEnrolled obrigatorio={false} podeExigirDaEquipe={false} empresaExige={false} />);
  return userEvent.setup().click(screen.getByRole("button", { name: "Regenerar códigos de recuperação" }));
}

describe("Configurações › Segurança: regenerar sem o código desta sessão", () => {
  it("mfa_required leva ao desafio, de volta para Segurança", async () => {
    regenerar.mockResolvedValue({ ok: false, error: "mfa_required" });
    await regenerarNaTela();
    await waitFor(() => expect(navegar).toHaveBeenCalledWith("/login/mfa?next=/app/settings/security"));
    expect(toastErro).not.toHaveBeenCalled();
  });

  it("CONTROLE: outro erro fica na tela, sem desvio", async () => {
    regenerar.mockResolvedValue({ ok: false, error: "mfa_not_enrolled" });
    await regenerarNaTela();
    await waitFor(() => expect(toastErro).toHaveBeenCalledTimes(1));
    expect(navegar).not.toHaveBeenCalled();
  });

  it.each([
    ["service_unavailable", "Gerar códigos de recuperação não está disponível nesta instalação."],
    ["mfa_not_enrolled", "Ative a verificação em duas etapas antes de gerar os códigos."],
    ['duplicate key value violates unique constraint "idx_recovery_unique"', "Não foi possível gerar os códigos. Tente de novo."],
  ])("o erro %s vira frase, nunca o código cru", async (erro, frase) => {
    regenerar.mockResolvedValue({ ok: false, error: erro });
    await regenerarNaTela();
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(frase));
  });
});
