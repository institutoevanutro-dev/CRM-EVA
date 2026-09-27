"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { configEvalink } from "@/lib/evalink/config";
import {
  authRateLimited,
  contaBloqueadaPorFalhas,
  registrarFalhaDeLogin,
  AUTH_LIMITS,
} from "@/lib/auth/rate-limit";

export type SignInResult = {
  ok: false;
  error: "invalid_credentials" | "rate_limited" | "validation_error" | "mfa_required";
  details?: Record<string, unknown>;
  challengeId?: string;
};

/**
 * Sign in with password.
 *
 * On success: redirects server-side to `next` (or /app/inbox / /onboarding/mfa).
 * The redirect ensures Set-Cookie headers from supabase.auth propagate before
 * middleware re-evaluates the session — fixes Next 15 Server Action cookie
 * propagation race.
 *
 * On failure: returns an error discriminator. Caller renders inline message.
 */
export async function signInWithPassword(input: LoginInput, next?: string): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Antes de falar com o GoTrue: sem isto, tentar senha era de graça e
  // ilimitado (issue #64). Conta por IP e por conta — o ataque distribuído
  // contra um e-mail só não aparece na contagem por IP.
  if (
    (await authRateLimited("login", null, AUTH_LIMITS.login)) ||
    (await contaBloqueadaPorFalhas(parsed.data.email, AUTH_LIMITS.login))
  ) {
    await audit({
      action: "auth.login_rate_limited",
      metadata: { email_hash: hashEmail(parsed.data.email) },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "rate_limited" };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    // Só senha errada gasta o orçamento da conta.
    await registrarFalhaDeLogin(parsed.data.email, AUTH_LIMITS.login);
    await audit({
      action: "auth.login_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error?.message ?? "unknown",
      },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "invalid_credentials" };
  }

  // Senha só é reserva para quem está ligado à Conta EvaLink: com o EvaLink
  // ligado, quem tem vínculo em `evalink_vinculos` só entra por senha se for
  // admin ativo (org ou plataforma) — senão a senha vira uma segunda porta
  // para uma conta que devia entrar só pela Conta.
  if (configEvalink()) {
    const admin = createAdminClient();
    const vinculo = await admin
      .from("evalink_vinculos")
      .select("user_id")
      .eq("user_id", data.user.id)
      .maybeSingle();

    if (vinculo.data) {
      const [orgAdmin, platformAdmin] = await Promise.all([
        admin
          .from("user_organizations")
          .select("id")
          .eq("user_id", data.user.id)
          .eq("role", "admin")
          .is("revoked_at", null)
          .limit(1),
        admin
          .from("platform_admins")
          .select("user_id")
          .eq("user_id", data.user.id)
          .is("revoked_at", null)
          .maybeSingle(),
      ]);
      const ehAdmin = (orgAdmin.data?.length ?? 0) > 0 || Boolean(platformAdmin.data);

      if (!ehAdmin) {
        await supabase.auth.signOut();
        await registrarFalhaDeLogin(parsed.data.email, AUTH_LIMITS.login);
        await audit({
          action: "auth.login_failed",
          metadata: {
            email_hash: hashEmail(parsed.data.email),
            reason: "evalink_reserva",
          },
          requestId,
          ip,
          userAgent,
        });
        return { ok: false, error: "invalid_credentials" };
      }
    }
  }

  // MFA gating — if the user has any verified TOTP factor enrolled, they must
  // complete the challenge in /login/mfa before reaching the app.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedTotp = factorsData?.totp?.find((f) => f.status === "verified");
  if (verifiedTotp) {
    return { ok: false, error: "mfa_required", challengeId: verifiedTotp.id };
  }

  await audit({
    action: "auth.login_success",
    actorUserId: data.user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  // Server-side redirect ensures fresh session cookie is sent to browser.
  redirect(safeNext(next, "/app"));
}
