/**
 * Server guard for /admin/* (Super-Admin Platform sub-product).
 *
 * Flow:
 *  1. Validate JWT via getUser() (NEVER getSession on backend per CLAUDE.md).
 *  2. Confirm row in platform_admins (active = no revoked_at).
 *  3. Enforce MFA AAL2 for enrolled factors or a required enrollment policy.
 *
 * Redirects:
 *  - no user        → /login?next=/admin
 *  - no row         → /admin/forbidden
 *  - aal1 + required → /login/mfa?next=/admin
 *
 * The middleware already does an early `fn_is_platform_admin` RPC check;
 * this helper performs the authoritative server-side validation inside the
 * /admin layout (where redirects are cheap, DB calls are allowed in Node
 * runtime, and we have access to AAL state).
 */
import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { fail, type ApiError } from "@/lib/api/wrappers";
import { EscritaDePlatformAdminNegada } from "@/lib/auth/recusa-de-escrita-de-admin";
import { mfaEmDivida } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export interface PlatformAdminInfo {
  user_id: string;
  scope: string;
  mfa_required: boolean;
}

export interface PlatformAdminContext {
  user: User;
  platformAdmin: PlatformAdminInfo;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  return entrar(false);
}

// A classe mora no módulo sem `next/*` para o formulário ler a mesma frase.
export { EscritaDePlatformAdminNegada };

/**
 * `requirePlatformAdmin()` + o que a ESCRITA exige e a leitura não:
 * `scope === 'full'` (o `support_readonly` lê o painel e nada muda).
 *
 * `requirePlatformAdmin` devolvia o scope sem impor; só quatro rotas conferiam
 * à mão. A cerca `tests/unit/admin-escrita-exige-scope-full.test.ts` exige este
 * helper em todo handler de escrita e em toda server action de admin.
 *
 * Mantém o contrato de `requirePlatformAdmin` para quem não é platform admin
 * (REDIRECIONA). As recusas da escrita LANÇAM `EscritaDePlatformAdminNegada` —
 * inclusive a dívida de MFA, que na leitura é redirect: capturado por uma rota
 * de API, o redirect viraria um 403 sem motivo.
 *
 * Porte de melgarafael/DeskcommCRM 34a554b37.
 */
export async function requirePlatformAdminEscrita(): Promise<PlatformAdminContext> {
  return entrar(true);
}

async function entrar(escrita: boolean): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/admin");
  }

  // platform_admins RLS: only platform admins read; non-admins get null → forbid.
  const { data: paRow } = await supabase
    .from("platform_admins")
    .select("user_id, scope, mfa_required, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  if (!paRow) {
    redirect("/admin/forbidden");
  }

  if (escrita && paRow.scope !== "full") throw new EscritaDePlatformAdminNegada("forbidden_scope");

  const semSegundoFator = (): never => {
    if (escrita) throw new EscritaDePlatformAdminNegada("mfa_required");
    redirect("/login/mfa?next=/admin");
  };

  if (await mfaEmDivida()) semSegundoFator();

  if (paRow.mfa_required) {
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.currentLevel !== "aal2") semSegundoFator();
  }

  return {
    user,
    platformAdmin: {
      user_id: paRow.user_id,
      scope: paRow.scope,
      mfa_required: paRow.mfa_required,
    },
  };
}

/**
 * Resposta de rota para o que `requirePlatformAdminEscrita` lançou. A recusa
 * nomeada vira o seu código; o resto (redirect de quem não é platform admin,
 * sessão ilegível) vira o 403 `forbidden` que as rotas de admin já davam.
 */
export function falhaDaEscritaDePlatformAdmin(
  err: unknown,
  requestId?: string,
  mensagemDeRecusa = "Platform admin required",
): NextResponse<ApiError> {
  if (err instanceof EscritaDePlatformAdminNegada) return fail(err.code, err.message, 403, { requestId });
  return fail("forbidden", mensagemDeRecusa, 403, { requestId });
}
