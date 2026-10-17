// @vitest-environment jsdom
/**
 * A TELA Admin › Google AVISA NA HORA a chave colada junto com o arquivo.
 *
 * Portado do projeto original (DeskcommCRM, PR #2493 de @Aleshan-dev). Lá a
 * prova de tela é um caso Playwright; aqui, o mesmo comportamento no
 * componente real: colagem com aspa/vírgula → aviso visível e Salvar travado;
 * valor limpo → aviso some e Salvar habilita.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/actions/settings/updateGoogleOAuth", () => ({ updateGoogleOAuth: vi.fn() }));

import { FormularioDoGoogle } from "@/app/admin/(protected)/google/_form";

afterEach(() => cleanup());

const SECRET_LIMPO = "GOCSPX-abcdEFGH1234_ijklMNOP5678-qrs";

describe("formulário do Google: chave colada com o resto do arquivo", () => {
  it("avisa e trava o Salvar; com o valor limpo, o aviso some e o Salvar habilita", () => {
    render(
      <FormularioDoGoogle
        clientIdSalvo="000000000000-exemplofalsoparateste000000000.apps.googleusercontent.com"
        temSegredoSalvo={false}
        atualizadoEm={null}
        temNoAmbiente={false}
        enderecoDeRetorno="https://crm.exemplo.test/api/v1/agenda/google/callback"
      />,
    );
    const campo = screen.getByTestId("google-client-secret");
    const salvar = screen.getByTestId("google-salvar") as HTMLButtonElement;

    fireEvent.change(campo, { target: { value: `${SECRET_LIMPO}","redirect_uris` } });
    expect(screen.getByTestId("google-secret-formato-ruim")).toBeInTheDocument();
    expect(salvar.disabled).toBe(true);

    fireEvent.change(campo, { target: { value: SECRET_LIMPO } });
    expect(screen.queryByTestId("google-secret-formato-ruim")).not.toBeInTheDocument();
    expect(salvar.disabled).toBe(false);
  });
});
