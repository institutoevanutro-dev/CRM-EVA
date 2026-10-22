import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ required: false, enrolled: true, aal: "aal1" }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(url); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  // `isMfaEnrolled` lê `user.factors` da mesma ida do `getUser` (#3122).
  auth: { getUser: async () => ({
    data: { user: { id: "admin", factors: state.enrolled ? [{ factor_type: "totp", status: "verified" }] : [] } },
    error: null,
  }), mfa: {
    listFactors: async () => ({ data: { totp: state.enrolled ? [{ status: "verified" }] : [] }, error: null }),
    getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal }, error: null }),
  } },
  from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { user_id: "admin", scope: "full", mfa_required: state.required } }) }) }) }) }),
}) }));
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
beforeEach(() => { state.required = false; state.enrolled = true; state.aal = "aal1"; });
it("exige fator cadastrado mesmo com política opcional", async () => {
  await expect(requirePlatformAdmin()).rejects.toThrow("/login/mfa?next=/admin");
});
it("aceita segundo fator comprovado", async () => {
  state.aal = "aal2";
  await expect(requirePlatformAdmin()).resolves.toHaveProperty("platformAdmin.user_id", "admin");
});
it("mantém acesso sem fator quando cadastro é opcional", async () => {
  state.enrolled = false;
  await expect(requirePlatformAdmin()).resolves.toHaveProperty("platformAdmin.user_id", "admin");
});
it("exige MFA quando a política obriga", async () => {
  state.enrolled = false; state.required = true;
  await expect(requirePlatformAdmin()).rejects.toThrow("/login/mfa?next=/admin");
});
