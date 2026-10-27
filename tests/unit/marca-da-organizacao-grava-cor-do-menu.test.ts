// @vitest-environment node
/**
 * SÓ A COR DO MENU PREENCHIDA NÃO É "LIMPAR".
 *
 * `updateMarcaDaOrganizacao` manda `p_marca: null` (apagar a chave `branding`)
 * quando todos os campos vêm vazios. Com a cor do menu lateral, nome e cor da
 * marca vazios deixaram de bastar: quem escolheu só o menu tem de ver o menu
 * gravado, e não a marca inteira apagada. Executa a action com o banco dublado
 * na chamada de RPC e mede o que chegou a ele, e o que foi auditado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_nome: string, _args: Record<string, unknown>) => ({ data: 1, error: null })),
  audit: vi.fn(async (_entrada: Record<string, unknown>) => undefined),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", is_platform_admin: false, support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

beforeEach(() => {
  h.rpc.mockClear();
  h.audit.mockClear();
});

describe("updateMarcaDaOrganizacao com só a cor do menu", () => {
  it("grava o menu normalizado em vez de apagar a marca", async () => {
    const { updateMarcaDaOrganizacao } = await import(
      "@/app/actions/settings/updateMarcaDaOrganizacao"
    );
    const r = await updateMarcaDaOrganizacao({
      app_name: null,
      accent_hex: null,
      menu_hex: "#ABC",
    });
    expect(r).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [nome, args] = h.rpc.mock.calls[0]!;
    expect(nome).toBe("fn_definir_marca_da_organizacao");
    expect(args.p_marca).not.toBeNull();
    expect(args.p_marca).toMatchObject({ app_name: null, accent_hex: null, menu_hex: "#aabbcc" });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      action: "org.branding_updated",
      metadata: { menu_definido: true, accent_definido: false },
    });
  });

  it("os três vazios continuam sendo limpar", async () => {
    const { updateMarcaDaOrganizacao } = await import(
      "@/app/actions/settings/updateMarcaDaOrganizacao"
    );
    await updateMarcaDaOrganizacao({ app_name: null, accent_hex: null, menu_hex: null });
    expect(h.rpc.mock.calls[0]![1].p_marca).toBeNull();
  });
});
