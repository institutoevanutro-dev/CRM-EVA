/**
 * O NOME SOB O "ENTRAR" É O MESMO DO TÍTULO DA ABA.
 *
 * Achado da prova no Safari (11/11): com a Conta em vigor, o título dizia
 * "Entrar · CRM · Clínica X" e a tela mostrava o nome do produto, porque a página
 * lia `branding()` (só `.env`). Agora ela usa `marcaDaSaida(null)`, a mesma pilha
 * Conta → banco → `.env` do layout raiz.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => null }));
vi.mock("@/lib/evalink/config", () => ({ configEvalink: () => null }));
const linha = vi.hoisted(() => ({ atual: null as Record<string, unknown> | null }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => linha.atual }));

async function subtitulo(): Promise<string> {
  vi.resetModules();
  const { default: LoginPage } = await import("@/app/(public)/login/page");
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
  return /<p class="text-sm text-muted-foreground">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
}

describe("/login: o nome sob o título", () => {
  it("com a Conta em vigor, é \"CRM · <clínica>\"", async () => {
    linha.atual = { app_name: "Local", conta_nome: "Clínica Aurora", conta_accent_hex: "#27463b" };
    expect(await subtitulo()).toBe("CRM · Clínica Aurora");
  });

  it("com marca no banco e sem Conta, é a do banco", async () => {
    linha.atual = { app_name: "Revenda XPTO" };
    expect(await subtitulo()).toBe("Revenda XPTO");
  });

  it("sem banco e sem Conta, é a do `.env` — como era antes", async () => {
    linha.atual = null;
    vi.stubEnv("APP_NAME", "Do Env");
    try {
      expect(await subtitulo()).toBe("Do Env");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
