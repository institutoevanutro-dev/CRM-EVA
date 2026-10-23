"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { sessionAal } from "@/lib/auth/server";
import { logger } from "@/lib/logger";

export type ConfirmMfaEnrollResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: "invalid_code" | "challenge_failed" | "verify_failed"; message?: string }
  | { ok: false; error: "mfa_required" | "service_unavailable" | "recovery_codes_failed" };

/**
 * Confirms a TOTP enrollment by issuing a challenge + verifying the code, then
 * generates 10 single-use recovery codes (`hashRecoveryCode`, stored as bytea).
 *
 * Recovery codes are returned ONCE to the caller for display — never stored
 * plaintext. Caller is responsible for showing them to the user with copy /
 * download / acknowledge UX.
 */
export async function confirmMfaEnroll(
  code: string,
  factorId: string,
): Promise<ConfirmMfaEnrollResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "invalid_code" };
  }

  // A mesma régua de `enrollMfa`: com um fator verificado, confirmar outro (e
  // receber códigos de recuperação) exige o atual provado nesta sessão.
  const { data: fatores, error: listErr } = await supabase.auth.mfa.listFactors();
  // Sem a lista não dá para saber se a conta já tem fator: recusa em vez de
  // tratar como primeiro cadastro.
  if (listErr) return { ok: false, error: "challenge_failed", message: listErr.message };
  const temFatorVerificado = fatores?.all?.some(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
  if (temFatorVerificado && (await sessionAal()) !== "aal2") {
    return { ok: false, error: "mfa_required" };
  }

  // Os códigos só são gravados pelo client de serviço. Sem ele, recusa ANTES de
  // verificar o fator: depois, o fator ficaria ativo sem códigos.
  if (!isServiceRoleConfigured()) return { ok: false, error: "service_unavailable" };

  // Gerados antes do desafio pelo mesmo motivo: se o hash não puder ser feito
  // (sem o INTERNAL_SECRET), a falha vem antes de o fator ficar ativo.
  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "challenge_failed", message: challengeErr?.message };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    return { ok: false, error: "verify_failed", message: verifyErr.message };
  }

  // Substitui o conjunto anterior: os códigos mostrados agora são os únicos que valem.
  const admin = createAdminClient();
  const { error: delErr } = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
  const { error: insertErr } = delErr
    ? { error: delErr }
    : await admin.from("user_recovery_codes").insert(rows);
  if (insertErr) {
    // O fator já foi verificado. Repetir a confirmação grava os códigos (a sessão
    // está em aal2 agora); mostrar códigos que não foram gravados seria pior.
    logger.error("[mfa-confirmacao] não gravou os códigos de recuperação", {
      factor_id: factorId,
      error: insertErr.message,
    });
    return { ok: false, error: "recovery_codes_failed" };
  }

  await audit({
    action: "auth.mfa_enrolled",
    actorUserId: user.id,
    metadata: { recovery_codes_generated: codes.length },
    requestId,
    ip,
    userAgent,
  });

  return { ok: true, recovery_codes: codes };
}
