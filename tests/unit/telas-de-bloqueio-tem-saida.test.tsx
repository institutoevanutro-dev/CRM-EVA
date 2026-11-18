/**
 * TELAS DE BLOQUEIO TÊM SAÍDA (auditoria de 17/11, itens 54 e 55).
 *
 * - Conta suspensa: "Sair" era um link para /login, sem sair — a pessoa voltava
 *   para cá ao entrar; e quem é de outra organização ficava preso.
 * - Primeiro acesso ("Configure sua organização"): sem "Sair", quem entrou com a
 *   conta errada não tinha saída.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const signOut = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/auth/signOut", () => ({ signOut }));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({ emailDeSuporte: () => null, marcaDaSaida: async () => ({ nome: "CRM" }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn() }) }));

const ORGS = [
  { organization_id: "org-suspensa", organization_name: "Clínica Suspensa", role: "admin" },
  { organization_id: "org-ativa", organization_name: "Clínica Aurora", role: "agent" },
];
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", idioma: "pt-BR", locale: "pt-BR", organizations: ORGS }),
  requireAuth: async () => ({ id: "u1", idioma: "pt-BR", locale: "pt-BR", organizations: [] }),
  resolveActiveOrg: async () => null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", user_metadata: {} } } }) },
    from: () => ({
      select: () => ({
        in: async () => ({
          data: [
            { id: "org-suspensa", status: "suspended" },
            { id: "org-ativa", status: "active" },
          ],
          error: null,
        }),
      }),
    }),
  }),
}));
vi.mock("@/components/auth/RecoverOrganizationForm", () => ({ RecoverOrganizationForm: () => null }));

describe("telas de bloqueio", () => {
  it("conta suspensa: \"Sair\" sai de verdade e oferece só as outras organizações ativas", async () => {
    const { default: Pagina } = await import("@/app/account-suspended/page");
    const html = renderToStaticMarkup(await Pagina());
    expect(html).not.toContain('href="/login"');
    expect(html).toMatch(/<form[^>]*>.*Sair.*<\/form>/s);
    expect(html).toContain("Clínica Aurora");
    expect(html).not.toContain("Clínica Suspensa");
  });

  it("primeiro acesso: tem \"Sair\"", async () => {
    const { default: Pagina } = await import("@/app/get-started/page");
    const html = renderToStaticMarkup(await Pagina());
    expect(html).toContain("Entrou com outra conta? Sair");
    expect(html).toMatch(/<form[^>]*>[^]*Entrou com outra conta\? Sair[^]*<\/form>/);
  });
});
