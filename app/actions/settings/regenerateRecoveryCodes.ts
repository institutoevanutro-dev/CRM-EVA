"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { sessionAal } from "@/lib/auth/server";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";

export type RegenerateRecoveryCodesResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: string };

/**
 * Deletes existing user_recovery_codes for the current user and issues 10
 * fresh codes. Plaintext returned ONCE — never persisted.
 */
export async function regenerateRecoveryCodes(): Promise<RegenerateRecoveryCodesResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // Confirm user has a verified TOTP factor (regenerate is meaningless otherwise).
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasFactor = factors?.totp?.some((f) => f.status === "verified");
  if (!hasFactor) return { ok: false, error: "mfa_not_enrolled" };

  // Códigos de recuperação apagam o TOTP (`useRecoveryCode`): gerá-los com a
  // sessão `aal1` que o login deixa antes do desafio transformava a senha
  // sozinha em "desligar a verificação em duas etapas" (auditoria 2026-09-29, C2).
  if ((await sessionAal()) !== "aal2") return { ok: false, error: "mfa_required" };

  // Só o client de serviço grava os códigos, depois das checagens de sessão
  // acima. Sem ele a resposta diz isso, em vez de tentar pelo client do usuário.
  if (!isServiceRoleConfigured()) return { ok: false, error: "service_unavailable" };

  // O hash lança sem o INTERNAL_SECRET: antes de apagar os códigos atuais.
  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));

  const admin = createAdminClient();
  const { error: delErr } = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
  if (delErr) return { ok: false, error: delErr.message ?? "delete_failed" };
  const { error: insErr } = await admin.from("user_recovery_codes").insert(rows);
  if (insErr) return { ok: false, error: insErr.message ?? "insert_failed" };

  await audit({
    action: "mfa.recovery_codes_regenerated",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId,
    ip,
    userAgent,
    metadata: { count: codes.length },
  });

  return { ok: true, recovery_codes: codes };
}
