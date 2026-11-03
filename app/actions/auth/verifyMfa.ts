"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { mfaBloqueadoPorFalhas, registrarFalhaDeMfa } from "@/lib/auth/rate-limit";

export type VerifyMfaResult =
  | { ok: false; error: "mfa_invalid" }
  | { ok: false; error: "mfa_locked"; retry_in_seconds: number };

const ATTEMPT_COOKIE = "mfa_attempts";
const ATTEMPT_TTL_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/**
 * Confere o código TOTP do fator verificado e, se acertar, sobe a sessão para
 * AAL2. Dois limites de erro se somam:
 *  - no servidor (`mfaBloqueadoPorFalhas` em `lib/auth/rate-limit.ts`): 3
 *    erros por usuário no minuto (janela fixa; 30 por IP) e 15 por usuário no
 *    dia (UTC), o MESMO balde do `updatePassword` — é ele que barra o cliente
 *    que não devolve o cookie;
 *  - o cookie `mfa_attempts`, por navegador: 3 erros em 60 s desde o último.
 *
 * `retry_in_seconds` é sempre 60, mesmo quando quem barrou foi a janela diária.
 */
export async function verifyMfa(code: string, next?: string): Promise<VerifyMfaResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sanity-check: must have a verified TOTP factor.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const totp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!totp) redirect("/app");

  // Lockout check (cookie counter).
  const store = await cookies();
  const raw = store.get(ATTEMPT_COOKIE)?.value;
  let attempts = 0;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) attempts = parsed;
  }
  if (attempts >= MAX_ATTEMPTS || (await mfaBloqueadoPorFalhas(user.id))) {
    return { ok: false, error: "mfa_locked", retry_in_seconds: ATTEMPT_TTL_SECONDS };
  }

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "mfa_invalid" };
  }

  // Issue challenge + verify.
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "mfa_invalid" };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });

  if (verifyErr) {
    await registrarFalhaDeMfa(user.id);
    const newAttempts = attempts + 1;
    store.set(ATTEMPT_COOKIE, String(newAttempts), {
      httpOnly: true,
      sameSite: "strict",
      secure: cookieSecure(),
      maxAge: ATTEMPT_TTL_SECONDS,
      path: "/",
    });
    const locked = newAttempts >= MAX_ATTEMPTS;
    await audit({
      action: "auth.mfa_failed",
      actorUserId: user.id,
      metadata: { locked, attempts: newAttempts },
      requestId,
      ip,
      userAgent,
    });
    if (locked) {
      return { ok: false, error: "mfa_locked", retry_in_seconds: ATTEMPT_TTL_SECONDS };
    }
    return { ok: false, error: "mfa_invalid" };
  }

  // Reset attempt counter and audit success.
  store.delete(ATTEMPT_COOKIE);
  await audit({
    action: "auth.mfa_success",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  redirect(safeNext(next, "/app"));
}
