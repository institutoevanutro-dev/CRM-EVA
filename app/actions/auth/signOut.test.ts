import { beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn(async (_opts?: { scope?: string }) => ({ error: null }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ delete: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }), signOut },
  }),
}));

/**
 * Auditoria de 17/11/2026, item 46: `signOut()` sem escopo é GLOBAL no
 * supabase-js. "Sair" no celular derrubava a recepção inteira.
 */
describe("signOut (menu › Sair)", () => {
  beforeEach(() => signOut.mockClear());

  it("encerra só a sessão deste aparelho", async () => {
    const { signOut: sair } = await import("./signOut");
    await sair();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
