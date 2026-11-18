/**
 * /login/reset (auditoria de 17/11, item 48): a tela mostra de quem é a conta e
 * só oferece a troca para a conta do link de recuperação verificado.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { marcaDaTroca } from "@/lib/auth/troca-de-senha";

const estado = vi.hoisted(() => ({ marca: undefined as string | undefined, user: null as { id: string } | null }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: (n: string) => (n === "troca_de_senha" && estado.marca ? { value: estado.marca } : undefined) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: estado.user } }) } }),
}));
vi.mock("@/components/auth/ResetPasswordForm", () => ({ ResetPasswordForm: () => <form data-testid="form-da-troca" /> }));

async function abrir(): Promise<string> {
  const { default: Pagina } = await import("@/app/(public)/login/reset/page");
  return renderToStaticMarkup(await Pagina());
}

describe("/login/reset", () => {
  beforeEach(() => {
    estado.marca = undefined;
    estado.user = null;
  });

  it("sessão de outra pessoa no navegador, sem link verificado: sem formulário", async () => {
    estado.user = { id: "u-recepcao" };
    const html = await abrir();
    expect(html).not.toContain("form-da-troca");
    expect(html).toContain("Este link não vale mais. Peça um novo em Esqueci minha senha.");
  });

  it("link verificado, mas a sessão é de outra conta: sem formulário", async () => {
    estado.marca = marcaDaTroca("u-ana", "ana@exemplo.test");
    estado.user = { id: "u-recepcao" };
    expect(await abrir()).not.toContain("form-da-troca");
  });

  it("link verificado (1ª carga vinda do e-mail, sem cookie de sessão): mostra a conta e o formulário", async () => {
    estado.marca = marcaDaTroca("u-ana", "ana@exemplo.test");
    const html = await abrir();
    expect(html).toContain("form-da-troca");
    expect(html).toContain("Nova senha para");
    expect(html).toContain("ana@exemplo.test");
  });
});
