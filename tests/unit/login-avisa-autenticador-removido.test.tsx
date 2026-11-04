/**
 * DEPOIS DO CÓDIGO DE RECUPERAÇÃO, A TELA DE ENTRADA DIZ O QUE ACONTECEU.
 *
 * `useRecoveryCode` apaga o autenticador e sempre leva a `/login?recovery_used=1`,
 * venha a pessoa da entrada ou da troca de senha. A página não lia o parâmetro:
 * quem estava TROCANDO a senha caía num formulário pedindo justamente a senha
 * que não sabe, sem aviso nenhum. O aviso aponta o link novo; voltar para
 * `/login/reset` com a mesma sessão não serve, porque o cookie dela ainda lista
 * o autenticador apagado.
 *
 * Server Component async: chama a função e renderiza a árvore que ela devolve,
 * como `marca-na-fachada-de-acesso.test.tsx`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => null }));
const evalink = vi.hoisted(() => ({ ligado: false }));
vi.mock("@/lib/evalink/config", () => ({ configEvalink: () => (evalink.ligado ? { url: "https://conta.exemplo" } : null) }));

async function entrar(params: Record<string, string>): Promise<string> {
  const { default: LoginPage } = await import("@/app/(public)/login/page");
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

describe("/login depois do código de recuperação", () => {
  it("com recovery_used=1, diz que o autenticador saiu e manda quem trocava a senha pedir um link novo", async () => {
    const html = await entrar({ recovery_used: "1" });

    expect(html).toContain("Autenticador removido. Entre com a sua senha.");
    expect(html).toContain("Se você estava trocando a senha, peça um novo link em “Esqueci minha senha”.");
  });

  it("com o EvaLink ligado, o aviso não manda só usar a senha (quem entra pelo EvaLink não tem)", async () => {
    evalink.ligado = true;
    try {
      const html = await entrar({ recovery_used: "1" });
      expect(html).toContain("Entre de novo, pelo EvaLink ou com a sua senha.");
      expect(html).not.toContain("Entre com a sua senha.");
    } finally {
      evalink.ligado = false;
    }
  });

  it("sem o parâmetro, nenhum aviso", async () => {
    const html = await entrar({});

    expect(html).not.toContain("Autenticador removido");
    // Guarda de vacuidade: a página renderizou (o link que o aviso cita está nela).
    expect(html).toContain('href="/login/forgot"');
  });
});
