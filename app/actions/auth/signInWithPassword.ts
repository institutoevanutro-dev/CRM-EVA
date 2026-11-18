"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { configEvalink } from "@/lib/evalink/config";
import { reservaBloqueia } from "@/lib/evalink/reserva";
import {
  authRateLimited,
  contaBloqueadaPorFalhas,
  registrarFalhaDeLogin,
  AUTH_LIMITS,
} from "@/lib/auth/rate-limit";

export type SignInResult = {
  ok: false;
  error:
    | "invalid_credentials"
    | "rate_limited"
    | "validation_error"
    | "mfa_required"
    | "email_not_confirmed"
    | "unavailable";
  details?: Record<string, unknown>;
  challengeId?: string;
};

/**
 * Por que o GoTrue recusou. `status` ausente, 0 ou 5xx é o servidor que não
 * respondeu (o supabase-js embrulha falha de rede em status 0); 429 é o teto
 * do próprio GoTrue. O resto dos 4xx continua contando como credencial errada:
 * na dúvida, o teto de tentativas vale.
 */
function causaDaRecusa(
  error: { status?: number; code?: string; message?: string } | null,
): "invalid_credentials" | "email_not_confirmed" | "unavailable" | "rate_limited" {
  if (!error) return "invalid_credentials";
  if (error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message ?? "")) {
    return "email_not_confirmed";
  }
  if (!error.status || error.status >= 500) return "unavailable";
  if (error.status === 429) return "rate_limited";
  return "invalid_credentials";
}

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
    // Nem toda recusa é senha errada (auditoria 17/11, item 50). E-mail não
    // confirmado e servidor de login fora do ar viravam "Email ou senha
    // incorretos" e gastavam tentativa: a pessoa errava de propósito, achando
    // que a senha estava errada, até ser trancada por algo que não era dela.
    const causa = causaDaRecusa(error);
    if (causa !== "invalid_credentials") {
      await audit({
        action: "auth.login_failed",
        metadata: { email_hash: hashEmail(parsed.data.email), reason: causa },
        requestId,
        ip,
        userAgent,
      });
      return { ok: false, error: causa };
    }
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
  // admin ativo (org ou plataforma). A regra em si (e o fail-closed em erro de
  // consulta) mora em `reservaBloqueia`; aqui só a fiação.
  if (configEvalink() && (await reservaBloqueia(createAdminClient(), data.user.id))) {
    // scope "local": encerra só ESTA sessão recém-aberta pela senha, nunca as
    // sessões existentes da pessoa abertas pela Conta EvaLink.
    await supabase.auth.signOut({ scope: "local" });
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
