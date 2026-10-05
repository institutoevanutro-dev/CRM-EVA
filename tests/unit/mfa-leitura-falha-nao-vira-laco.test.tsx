/**
 * LEITURA DE FATOR QUE FALHA: ERRO NA TELA, NUNCA LAÇO DE REDIRECT — o lado do fork.
 *
 * `tests/unit/mfa-leitura-falha-fechado.test.ts` (porte do original) prova que
 * `isMfaEnrolled()` LANÇA quando o `listFactors()` devolve `{ data: null, error }`.
 * Este arquivo cobre o que só existe aqui: desde o PR 87 o `app/app/layout.tsx`
 * manda para `/login/mfa` quem tem fator e sessão `aal1`, e a página
 * `/login/mfa` manda de volta para `/app` quem "não tem fator". Se a página
 * lesse a falha como "sem fator", as duas telas se devolveriam uma à outra
 * enquanto a leitura oscilasse.
 *
 *  - PÁGINA: leitura que FALHOU não devolve para `/app` — mostra o formulário.
 *    (Visto falhar antes do conserto: a página chamava `redirect("/app")`.)
 *  - LAYOUT: a exceção de `isMfaEnrolled()` SOBE — não vira redirect para o
 *    desafio nem a casca do app. É um CONTROLE: o layout já propagava a
 *    rejeição do `Promise.all`; o caso existe para reprovar um futuro
 *    `.catch(() => false)` ali.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FALHA = Object.assign(new Error("fetch failed"), { name: "AuthRetryableFetchError", status: 0 });

const estado = vi.hoisted(() => ({
  isMfaEnrolled: async (): Promise<boolean> => true,
  listFactors: async (): Promise<unknown> => ({ data: { totp: [] }, error: null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", user_metadata: { locale: "pt-BR" } } }, error: null }),
      mfa: { listFactors: () => estado.listFactors() },
    },
  }),
}));
vi.mock("@/components/auth/MfaForm", () => ({ MfaForm: () => null }));

// ── só o layout precisa destes ───────────────────────────────────────────────
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: () => estado.isMfaEnrolled(),
  requiresMfa: async () => false,
  sessionAal: async () => "aal1",
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { onboarded_at: "2026-01-01", status: "active", settings: null } }),
        }),
      }),
    }),
  }),
}));

beforeEach(() => {
  estado.isMfaEnrolled = async () => true;
  estado.listFactors = async () => ({ data: { totp: [] }, error: null });
});

async function abrirDesafio(): Promise<ReactElement> {
  const { default: MfaChallengePage } = await import("@/app/(public)/login/mfa/page");
  return (await MfaChallengePage({ searchParams: Promise.resolve({ next: "/app" }) })) as ReactElement;
}

describe("/login/mfa — a página do desafio", () => {
  it("leitura que FALHOU não devolve para /app: mostra o formulário", async () => {
    estado.listFactors = async () => ({ data: null, error: FALHA });
    await expect(abrirDesafio()).resolves.toBeTruthy();
  });

  it("CONTROLE: leitura bem-sucedida SEM fator segue devolvendo para /app", async () => {
    await expect(abrirDesafio()).rejects.toThrow("redirect:/app");
  });

  it("CONTROLE: leitura bem-sucedida COM fator mostra o formulário", async () => {
    estado.listFactors = async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null });
    await expect(abrirDesafio()).resolves.toBeTruthy();
  });
});

describe("/app — a casca", () => {
  it("a falha de leitura SOBE como erro: nem redirect para o desafio, nem a casca do app", async () => {
    estado.isMfaEnrolled = async () => {
      throw FALHA;
    };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toBe(FALHA);
  });

  it("CONTROLE: com fator e sessão aal1 a casca manda para o desafio", async () => {
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/login/mfa?next=/app");
  });
});
