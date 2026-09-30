/**
 * C1 (agravante) — o convite do onboarding não gravava linha em
 * `team_invites`: não aparecia em Equipe e não podia ser revogado. Agora passa
 * pelo MESMO emissor de `/api/v1/team/invite` (`emitirConvite`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendOnboardingInvites } from "@/app/actions/onboarding/sendOnboardingInvites";
import { emitirConvite } from "@/lib/team/convites";

vi.mock("@/app/actions/onboarding/_shared", () => ({
  OnboardingError: class extends Error {},
  requireOnboardingCtx: vi.fn(async () => ({
    userId: "u1",
    orgId: "org1",
    orgName: "Clínica",
    role: "admin",
    fullName: "Dona",
    email: "dona@example.com",
  })),
  patchOnboardingState: vi.fn(async () => undefined),
}));
vi.mock("@/lib/team/convites", () => ({
  emitirConvite: vi.fn(async (_admin: unknown, p: { email: string }) => ({
    convite: { id: "inv1", expires_at: "2026-10-06T00:00:00Z" },
    accept_url: `https://crm.example/team/accept-invite/tok-${p.email}`,
    email_dispatched: false,
    renovado: false,
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("sendOnboardingInvites grava o convite em team_invites", () => {
  it("emite cada convite pelo emissor canônico, com a org da sessão", async () => {
    const r = await sendOnboardingInvites({
      invitations: [{ email: "Maria@Example.com", role: "agent" }],
    });
    expect(emitirConvite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitirConvite).mock.calls[0]![1]).toMatchObject({
      email: "maria@example.com",
      role: "agent",
      organizationId: "org1",
      inviterId: "u1",
    });
    expect(r).toMatchObject({
      ok: true,
      failed: 1,
      undelivered: [{ email: "maria@example.com" }],
    });
  });
});
