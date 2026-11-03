/**
 * A TROCA DE SENHA NUMA CONTA COM VERIFICAÇÃO EM DUAS ETAPAS DIZ POR QUE PAROU.
 *
 * O `updatePassword` confere o código do autenticador no mesmo balde da tela
 * de entrada (`mfaBloqueadoPorFalhas`), e o bloqueio volta como erro próprio.
 * Sem o ramo dele aqui, o bloqueio caía no "Não foi possível redefinir a
 * senha", que manda tentar de novo justamente quando tentar não adianta — e o
 * do dia some até as 21h. Nenhum outro teste olha esta tela: o e2e de troca de
 * senha só passa pelo código certo (o administrador dele é o de todas as specs,
 * e três erros trancariam o login da seguinte).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResetPasswordForm } from "./ResetPasswordForm";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/app/actions/auth/updatePassword", () => ({ updatePassword: vi.fn() }));

const { updatePassword } = await import("@/app/actions/auth/updatePassword");

async function definirSenha() {
  fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: "Nova-senha-1" } });
  fireEvent.change(screen.getByLabelText("Confirmar nova senha"), {
    target: { value: "Nova-senha-1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Definir nova senha" }));
  });
}

describe("ResetPasswordForm — o bloqueio do segundo fator", () => {
  beforeEach(() => {
    vi.mocked(updatePassword).mockReset();
  });

  it("o teto curto avisa que são muitas tentativas e mantém o campo do código", async () => {
    vi.mocked(updatePassword).mockResolvedValue({ ok: false, error: "mfa_locked" });

    render(<ResetPasswordForm />);
    await definirSenha();

    expect(await screen.findByText("Muitas tentativas. Aguarde alguns minutos.")).toBeInTheDocument();
    expect(screen.getByLabelText("Código de verificação (2 etapas)")).toBeInTheDocument();
  });

  it("o teto do dia diz até quando, leva ao código de recuperação e avisa que depois vem um link novo", async () => {
    vi.mocked(updatePassword).mockResolvedValue({ ok: false, error: "mfa_locked_today" });

    render(<ResetPasswordForm />);
    await definirSenha();

    const aviso = await screen.findByText(/21h \(horário de Brasília\)/);
    // O código de recuperação leva a /login, não de volta para cá: sem isto a
    // pessoa chegava lá sem saber que a troca precisa de outro e-mail.
    expect(aviso).toHaveTextContent(
      "depois do código de recuperação, peça um novo link em “Esqueci minha senha”",
    );
    expect(screen.getByLabelText("Código de verificação (2 etapas)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Perdi acesso ao autenticador" })).toHaveAttribute(
      "href",
      "/login/recovery",
    );
  });
});
