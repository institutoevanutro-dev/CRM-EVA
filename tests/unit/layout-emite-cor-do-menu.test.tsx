/**
 * O LAYOUT DE `/app` EMITE O BLOCO DA ORGANIZAÇÃO QUANDO SÓ HÁ COR DE MENU.
 *
 * O portão do layout emitia o bloco só quando a COR DA MARCA vinha da
 * organização. Com a cor do menu lateral (`settings.branding.menu_hex`), uma
 * organização pode escolher o menu sem escolher marca, e o bloco tem de sair
 * mesmo assim. Executa o `AppLayout` de verdade, como
 * `faixa-de-conexao-caida-vem-do-seam.test.tsx`, e mede o CSS entregue.
 */
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let settingsDaOrg: unknown = null;
const adminClient = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { onboarded_at: "2026-01-01", status: "active", settings: settingsDaOrg },
        }),
      }),
    }),
  }),
};

vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
  sessionAal: async () => "aal2",
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect inesperado para ${destino}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
// A instalação sem marca: o que estiver no bloco veio da organização.
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => null }));

/** O `css` entregue ao primeiro elemento que recebe essa prop. */
function cssEntregue(no: ReactNode): string | null | undefined {
  if (!no || typeof no !== "object") return undefined;
  if (Array.isArray(no)) {
    for (const filho of no) {
      const achado = cssEntregue(filho as ReactNode);
      if (achado !== undefined) return achado;
    }
    return undefined;
  }
  const props = (no as ReactElement<{ css?: string | null; children?: ReactNode }>).props;
  if (props && "css" in props) return props.css ?? null;
  return cssEntregue(props?.children);
}

async function renderizar(): Promise<string | null | undefined> {
  const { default: AppLayout } = await import("@/app/app/layout");
  return cssEntregue((await AppLayout({ children: null })) as ReactElement);
}

beforeEach(() => {
  settingsDaOrg = null;
});

describe("o portão do bloco da organização", () => {
  it("cor de menu sem cor de marca: o bloco sai, só com os tokens do menu", async () => {
    settingsDaOrg = { branding: { menu_hex: "#111111" } };
    const css = await renderizar();
    expect(css).toContain("body:has([data-marca-org])");
    expect(css).toContain("--color-sidebar-bg: #111111;");
    expect(css).toContain("--color-sidebar-tint:");
    expect(css).not.toContain("--color-brand");
  });

  it("sem cor de menu e sem marca da organização: nada sai", async () => {
    settingsDaOrg = { branding: { app_name: "Loja" } };
    expect(await renderizar()).toBeNull();
  });

  it("marca da organização sem menu: o bloco sai sem nenhum token do menu", async () => {
    settingsDaOrg = { branding: { accent_hex: "#263e0f" } };
    const css = await renderizar();
    expect(css).toContain("--color-brand");
    expect(css).not.toContain("--color-sidebar");
  });
});
