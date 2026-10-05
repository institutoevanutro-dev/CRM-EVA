"use server";

/**
 * Server Action: start the Nuvemshop OAuth flow for the active org.
 *
 * Resolves auth + active org, validates env config, mints an HMAC-signed state
 * token, then redirects to Nuvemshop's authorize URL. If credentials aren't
 * configured (dev / fresh deploy), returns `{ ok: false, error: "not_configured" }`
 * so the UI can render the "configure env" card without crashing.
 */

import { escreveComoPlatformAdmin } from "@/lib/auth/types";
import { supportWriteError, authenticatedSessionId } from "@/lib/impersonate/support";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { buildAuthorizeUrl } from "@/lib/nuvemshop/oauth";
import { getConfig } from "@/lib/nuvemshop/config";
import {
  CAMINHO_DO_CALLBACK_NUVEMSHOP,
  issueState,
  NOME_DO_VINCULO_NUVEMSHOP,
  VALIDADE_DO_VINCULO_NUVEMSHOP_S,
  vinculoDoState,
} from "@/lib/nuvemshop/state";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export type ConnectResult =
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "not_configured" };

export async function connectNuvemshop(): Promise<ConnectResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };

  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };

  // Only `admin` can wire up integrations (RBAC). `manager`/`agent`/`viewer`
  // see the UI read-only.
  if (activeOrg.role !== "admin" && !escreveComoPlatformAdmin(user)) {
    return { ok: false, error: "forbidden" };
  }

  const cfg = getConfig();
  if (!cfg) return { ok: false, error: "not_configured" };

  const nonce = randomBytes(16).toString("hex");
  const state = issueState(activeOrg.orgId, { userId: user.id, authSessionId: await authenticatedSessionId() }, nonce);
  // Lax (não Strict) porque a volta é navegação top-level vinda do parceiro.
  // O callback confere este cookie contra o nonce do `state` (M6).
  (await cookies()).set(NOME_DO_VINCULO_NUVEMSHOP, vinculoDoState(nonce), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_NUVEMSHOP,
    maxAge: VALIDADE_DO_VINCULO_NUVEMSHOP_S,
  });
  const url = buildAuthorizeUrl({ appId: cfg.appId, state });
  redirect(url);
}
