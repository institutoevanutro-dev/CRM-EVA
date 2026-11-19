/**
 * Clínica nova: o assistente e a entrada (auditoria 17/11, lote 17).
 *
 * - item 176: só quem monta o assistente é levado a ele;
 * - item 177: erro vira frase simples, e o "Pular" que falha avisa;
 * - item 178: passo feito vira link no indicador;
 * - item 47 (resposta 12 do André): com o EvaLink, a senha fica recolhida.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/onboarding/funil",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: vi.fn() }));

import { montaOAssistente } from "@/lib/onboarding/passos";
import { fraseDoErro, rodarOuAvisar } from "@/app/onboarding/_components/erros";
import { Stepper } from "@/app/onboarding/_components/Stepper";
import { LoginForm } from "@/components/auth/LoginForm";

afterEach(cleanup);
beforeEach(() => toastError.mockClear());

const pessoa = (is_platform_admin = false, platform_admin_scope: string | null = null) => ({
  is_platform_admin,
  platform_admin_scope,
});

describe("quem monta o assistente (item 176)", () => {
  it("admin e dono da instalação com escrita montam; o resto da equipe não", () => {
    expect(montaOAssistente("admin", pessoa())).toBe(true);
    expect(montaOAssistente("agent", pessoa(true, "full"))).toBe(true);
    for (const papel of ["viewer", "provider", "agent", "manager", null]) {
      expect(montaOAssistente(papel, pessoa()), String(papel)).toBe(false);
    }
    expect(montaOAssistente("agent", pessoa(true, "support_readonly"))).toBe(false);
  });
});

describe("erros do assistente (item 177)", () => {
  it("nenhum código chega cru à tela", () => {
    for (const codigo of ["auth_required", "forbidden", "no_active_org", "invalid_input", "db_error", undefined]) {
      const frase = fraseDoErro(codigo);
      if (codigo) expect(frase).not.toContain(codigo);
      expect(frase.length).toBeGreaterThan(10);
    }
  });

  it("o Pular que falha avisa; o redirect passa adiante", async () => {
    await rodarOuAvisar(async () => {
      throw new Error("An error occurred in the Server Components render");
    }, (t) => t);
    expect(toastError).toHaveBeenCalledWith("Não consegui pular este passo. Tente de novo.");

    toastError.mockClear();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/onboarding;307;" });
    await expect(rodarOuAvisar(async () => Promise.reject(redirect), (t) => t)).rejects.toBe(redirect);
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("indicador de passos (item 178)", () => {
  it("passo feito vira link; o atual e os por fazer não", () => {
    render(
      <Stepper
        passos={[
          { segmento: "welcome", rotulo: "Seu negócio", cumprido: true },
          { segmento: "funil", rotulo: "Onde ele organiza", cumprido: false },
          { segmento: "testar", rotulo: "Ver ele atender", cumprido: false },
        ]}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/onboarding/welcome"]);
  });
});

describe("login com o EvaLink (item 47, resposta 12)", () => {
  it("a senha fica recolhida em “Entrar com senha”", () => {
    const { container } = render(<LoginForm evalink />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(screen.getByText("Entrar com senha").tagName).toBe("SUMMARY");
  });

  it("abre de saída com `senhaAberta`, e sem EvaLink nem há o que recolher", () => {
    const { container, unmount } = render(<LoginForm evalink senhaAberta />);
    expect(container.querySelector("details")!.open).toBe(true);
    unmount();
    const semEvalink = render(<LoginForm />);
    expect(semEvalink.container.querySelector("details")).toBeNull();
    expect(semEvalink.container.querySelector("input[type=password]")).not.toBeNull();
  });
});
