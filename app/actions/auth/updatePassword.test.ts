import { beforeEach, describe, expect, it, vi } from "vitest";

import { marcaDaTroca } from "@/lib/auth/troca-de-senha";

const jar = vi.hoisted(() => ({ valor: undefined as string | undefined, delete: vi.fn() }));
const updateUser = vi.fn(async () => ({ error: null }));
const usuario = vi.hoisted(() => ({ atual: { id: "u-ana", email: "ana@exemplo.test" } as { id: string; email: string } | null }));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (n: string) => (n === "troca_de_senha" && jar.valor ? { value: jar.valor } : undefined),
    delete: jar.delete,
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: usuario.atual } }),
      updateUser,
      signOut: vi.fn(async () => ({ error: null })),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }) },
    },
  }),
}));

const SENHA = { password: "Nova-senha-ficticia-9", password_confirm: "Nova-senha-ficticia-9", mfa_code: "" };

/**
 * Auditoria de 17/11, item 48: a troca de senha sem a senha atual vale só para a
 * conta do link de recuperação verificado — nunca para a sessão de quem já
 * estava logado no navegador.
 */
describe("updatePassword", () => {
  beforeEach(() => {
    updateUser.mockClear();
    jar.delete.mockClear();
    usuario.atual = { id: "u-ana", email: "ana@exemplo.test" };
  });

  it("sessão comum, sem link verificado: recusa e não troca nada", async () => {
    jar.valor = undefined;
    const { updatePassword } = await import("./updatePassword");
    expect(await updatePassword(SENHA)).toEqual({ ok: false, error: "session_expired" });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("link verificado de OUTRA conta: recusa", async () => {
    jar.valor = marcaDaTroca("u-bruno", "bruno@exemplo.test");
    const { updatePassword } = await import("./updatePassword");
    expect(await updatePassword(SENHA)).toEqual({ ok: false, error: "session_expired" });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("CONTROLE — link verificado da própria conta: troca e apaga a marca", async () => {
    jar.valor = marcaDaTroca("u-ana", "ana@exemplo.test");
    const { updatePassword } = await import("./updatePassword");
    await updatePassword(SENHA);
    expect(updateUser).toHaveBeenCalledWith({ password: SENHA.password });
    expect(jar.delete).toHaveBeenCalledWith("troca_de_senha");
  });
});
