import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "self", support: null } as { id: string; support: { access_mode: string } | null } | null,
  rpc: vi.fn(async () => ({ error: null })), admin: vi.fn(), update: vi.fn(async () => ({ error: null })) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => state.user, resolveActiveOrg: async () => ({ orgId: "own-org", role: "viewer" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { updateUser: state.update } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { state.admin(); return { rpc: state.rpc }; } }));
import { updateProfile } from "@/app/actions/settings/updateProfile";
const input = { full_name: "Synthetic", locale: "pt-BR" as const, timezone: "America/Sao_Paulo" };
beforeEach(() => { vi.clearAllMocks(); state.user = { id: "self", support: null }; });
it("viewer altera o próprio perfil e o servidor emite somente o evento fixo", async () => {
  await expect(updateProfile(input)).resolves.toEqual({ ok: true });
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith("emit_event", expect.objectContaining({
    p_event_type: "user.profile_updated", p_entity_id: "self", p_organization_id: "own-org", p_payload: { user_id: "self" },
  }));
});
it("anônimo não alcança o cliente privilegiado", async () => {
  state.user = null;
  await expect(updateProfile(input)).resolves.toEqual({ ok: false, error: "unauthenticated" });
  expect(state.admin).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
});
it("suporte somente leitura não emite evento", async () => {
  state.user = { id: "self", support: { access_mode: "support_readonly" } };
  await updateProfile(input);
  expect(state.admin).not.toHaveBeenCalled();
});
