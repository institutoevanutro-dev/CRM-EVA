/**
 * A TELA DE ENTRADA, auditoria de 17/11 (itens 45, 52 e 53).
 *
 * - 45: quem cai no login porque a sessão terminou lê o porquê.
 * - 52: "Criar conta" abre uma clínica NOVA; com cadastro só por convite, ou com
 *   o EvaLink ligado, ele some.
 * - 53: o botão do EvaLink leva a tela de origem (`next`) adiante.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => null }));
const estado = vi.hoisted(() => ({ evalink: false, soEvalink: false, modo: "aberto" as "aberto" | "so_convite" }));
vi.mock("@/lib/evalink/config", () => ({
  configEvalink: () => (estado.evalink ? { url: "https://conta.exemplo" } : null),
  loginSoEvalink: () => estado.soEvalink,
}));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => "FORMULARIO_DE_SENHA" }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: async () => estado.modo }));

async function entrar(params: Record<string, string>): Promise<string> {
  const { default: LoginPage } = await import("@/app/(public)/login/page");
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

describe("/login", () => {
  it("motivo=sessao explica que a sessão terminou", async () => {
    expect(await entrar({ motivo: "sessao", next: "/app/contacts" })).toContain(
      "Sua sessão terminou. Entre de novo para voltar à tela onde estava.",
    );
    expect(await entrar({})).not.toContain("Sua sessão terminou");
  });

  it("cadastro só por convite: sem \"Criar conta\"", async () => {
    estado.modo = "so_convite";
    try {
      const html = await entrar({});
      expect(html).not.toContain('href="/signup"');
      expect(html).toContain('href="/login/forgot"');
    } finally {
      estado.modo = "aberto";
    }
  });

  it("EvaLink ligado: sem \"Criar conta\", e o botão leva o `next` interno", async () => {
    estado.evalink = true;
    try {
      const html = await entrar({ next: "/app/inbox?c=7" });
      expect(html).not.toContain('href="/signup"');
      expect(html).toContain('href="/evalink/entrar?next=%2Fapp%2Finbox%3Fc%3D7"');
      // Destino externo não atravessa.
      expect(await entrar({ next: "https://evil.example" })).toContain('href="/evalink/entrar"');
    } finally {
      estado.evalink = false;
    }
  });

  it("EVALINK_SO_EVALINK: só o botão do EvaLink, sem senha nem \"Esqueci minha senha\"", async () => {
    estado.evalink = true;
    estado.soEvalink = true;
    try {
      const html = await entrar({});
      expect(html).toContain('href="/evalink/entrar"');
      expect(html).not.toContain("FORMULARIO_DE_SENHA");
      expect(html).not.toContain('href="/login/forgot"');
      expect(html).not.toContain('href="/signup"');
    } finally {
      estado.evalink = false;
      estado.soEvalink = false;
    }
  });

  it("CONTROLE — EvaLink ligado sem a chave: a senha recolhida continua lá", async () => {
    estado.evalink = true;
    try {
      const html = await entrar({});
      expect(html).toContain("FORMULARIO_DE_SENHA");
      expect(html).toContain('href="/login/forgot"');
    } finally {
      estado.evalink = false;
    }
  });

  it("CONTROLE — cadastro aberto e sem EvaLink: \"Criar conta\" continua", async () => {
    expect(await entrar({})).toContain('href="/signup"');
  });
});
