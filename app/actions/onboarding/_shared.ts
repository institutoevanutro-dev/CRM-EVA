/**
 * Shared helpers for onboarding Server Actions: resolve auth + active org +
 * admin client (we use service-role here because we do narrow targeted
 * UPDATEs scoped explicitly by `organization_id` resolved from the validated
 * session — no body-derived ids ever).
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { escreveComoPlatformAdmin } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { OnboardingState } from "@/lib/schemas/onboarding";

export class OnboardingError extends Error {
  constructor(
    public readonly code:
      | "auth_required"
      | "no_active_org"
      | "forbidden"
      | "not_found"
      | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingCtx {
  userId: string;
  orgId: string;
  orgName: string;
  role: string;
  fullName: string | null;
  email: string;
}

export async function requireOnboardingCtx(): Promise<OnboardingCtx> {
  const user = await loadAuthUser();
  if (!user) throw new OnboardingError("auth_required", "Auth required.");
  if (supportWriteError(user.support)) throw new OnboardingError("forbidden", "Acompanhamento somente leitura ou encerrado.");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) throw new OnboardingError("no_active_org", "Sem organização ativa.");

  // O onboarding configura a organização inteira — agente, memória, funil e
  // convites COM PAPEL — e as ações usam service role. Sem esta checagem um
  // viewer convidava outra conta sua como admin (auditoria 2026-09-29, C1).
  // O papel vem do banco (a mesma função das policies), não do cookie.
  const supabase = await createClient();
  const { data: papel, error } = await supabase.rpc("fn_user_role_in_org", { p_org: activeOrg.orgId });
  if (error) throw new OnboardingError("db_error", error.message);
  // O atalho do dono da instalação exige scope `full`: o `support_readonly` tem
  // a mesma linha em `platform_admins` e não configura organização nenhuma.
  if (papel !== "admin" && !escreveComoPlatformAdmin(user)) {
    throw new OnboardingError("forbidden", "Só o administrador configura a organização.");
  }
  // Quem tem fator TOTP prova na sessão — o mesmo gate de `requireRole`.
  if (await mfaEmDivida()) {
    throw new OnboardingError("forbidden", "Esta sessão precisa da verificação em duas etapas.");
  }

  return {
    userId: user.id,
    orgId: activeOrg.orgId,
    orgName: activeOrg.name,
    role: (papel as string | null) ?? activeOrg.role,
    fullName: user.full_name,
    email: user.email,
  };
}

export async function loadOnboardingState(orgId: string): Promise<{
  state: OnboardingState;
  onboardedAt: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("onboarding_state, onboarded_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new OnboardingError("db_error", error.message);
  if (!data) throw new OnboardingError("not_found", "Organização não encontrada.");
  return {
    state: (data.onboarding_state as OnboardingState | null) ?? {},
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function patchOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
  extra?: { display_name?: string; timezone?: string },
): Promise<void> {
  const admin = createAdminClient();
  const { state } = await loadOnboardingState(orgId);
  const merged: OnboardingState = { ...state, ...patch };
  const update: Record<string, unknown> = { onboarding_state: merged };
  if (extra?.display_name) update.display_name = extra.display_name;
  if (extra?.timezone) update.timezone = extra.timezone;
  const { error } = await admin.from("organizations").update(update).eq("id", orgId);
  if (error) throw new OnboardingError("db_error", error.message);
}
