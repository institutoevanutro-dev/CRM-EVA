import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
/**
 * GET /api/v1/integrations/nuvemshop/callback
 *
 * OAuth callback. Validates state, exchanges code for token, encrypts it,
 * upserts tenant_integrations, and registers the 8 mandatory webhooks.
 *
 * Failure modes redirect back to the UI with `?error=<code>`. The action is
 * audited either way.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfig, SUBSCRIBED_EVENTS, eventToSlug } from "@/lib/nuvemshop/config";
import { exchangeCodeForToken } from "@/lib/nuvemshop/oauth";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";
import {
  CAMINHO_DO_CALLBACK_NUVEMSHOP,
  NOME_DO_VINCULO_NUVEMSHOP,
  verifyState,
  vinculoDoStateConfere,
} from "@/lib/nuvemshop/state";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

function redirectTo(path: string): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const res = NextResponse.redirect(new URL(path, base));
  // Toda saída passa aqui: o vínculo morre com o fluxo, sucesso ou erro.
  res.cookies.set(NOME_DO_VINCULO_NUVEMSHOP, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_NUVEMSHOP,
    maxAge: 0,
  });
  return res;
}

/** O papel pode ter caído nos dez minutos do consentimento: relê do banco. */
async function aindaPodeConectar(orgId: string, userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const [{ data: vinculo, error: e1 }, { data: plataforma, error: e2 }] = await Promise.all([
    admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle(),
    admin.from("platform_admins").select("user_id").eq("user_id", userId).is("revoked_at", null).maybeSingle(),
  ]);
  if (e1 || e2) return false;
  return (vinculo as { role?: string } | null)?.role === "admin" || Boolean(plataforma);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  const cfg = getConfig();
  if (!cfg) {
    return redirectTo(`/app/integrations/nuvemshop?error=not_configured`);
  }

  const state = verifyState(stateParam);
  if (!state) {
    // State não autenticado não pode criar linhas duráveis em audit_log.
    return redirectTo(`/app/integrations/nuvemshop?error=invalid_state`);
  }

  // M6: assinatura prova que o `state` é nosso; o cookie prova que quem volta
  // é o navegador que saiu. `state` sem ator é o formato antigo — sem ator não
  // há como reconferir o papel, então não serve mais.
  const { userId } = state;
  if (!userId || !vinculoDoStateConfere(req.cookies.get(NOME_DO_VINCULO_NUVEMSHOP)?.value, state.nonce)) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: "vinculo_ausente_ou_nao_confere" },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=invalid_state`);
  }

  if (!code) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: "missing_code" },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=missing_code`);
  }

  if (!(await supportCallbackWriteAllowed(state.orgId, state.userId, state.authSessionId))) return redirectTo("/app/integrations/nuvemshop?error=invalid_state");

  if (!(await aindaPodeConectar(state.orgId, userId))) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: "papel_insuficiente", user_id: userId },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=forbidden`);
  }

  // Uso único, ANTES de trocar o código (que também é de uso único — queimar
  // depois gastaria o `code` antes de saber que o `state` era repetido). A
  // tabela é a do OAuth da agenda: PK no nonce, poda no `data-retention`. O
  // prefixo separa os dois fluxos sem migration.
  const { error: erroDoNonce } = await createAdminClient().from("calendar_oauth_nonces").insert({
    nonce: `nuvemshop:${state.nonce}`,
    organization_id: state.orgId,
    user_id: userId,
    expira_em: new Date(state.expMs).toISOString(),
  });
  if (erroDoNonce) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: erroDoNonce.code === "23505" ? "state_reutilizado" : "nonce_indisponivel" },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=invalid_state`);
  }

  // Exchange code for access token.
  const tokenRes = await exchangeCodeForToken(code, cfg);
  if (!tokenRes.ok) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: tokenRes.error, status: tokenRes.status ?? null },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=${tokenRes.error}`);
  }

  const { accessToken, scope, storeId } = tokenRes;
  const admin = createAdminClient();

  // Encrypt access token + webhook secret (we keep the client_secret in env, but
  // tenant_integrations.webhook_secret_encrypted is NOT NULL — we store the
  // app's client_secret encrypted so the webhook handler can read it via the
  // same per-row decrypt path used by other providers). This also keeps the
  // door open for per-tenant rotation later.
  const encrypted = await admin.rpc("fn_encrypt_oauth", { plaintext: accessToken });
  if (encrypted.error || !encrypted.data) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: "encrypt_failed", error: encrypted.error?.message ?? "no_data" },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=encrypt_failed`);
  }
  const webhookSecretEnc = await admin.rpc("fn_encrypt_oauth", {
    plaintext: cfg.clientSecret,
  });
  if (webhookSecretEnc.error || !webhookSecretEnc.data) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: {
        reason: "encrypt_failed",
        error: webhookSecretEnc.error?.message ?? "no_data",
      },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=encrypt_failed`);
  }

  const webhookPathToken = randomBytes(24).toString("hex");
  const scopes = scope ? scope.split(/[\s,]+/).filter(Boolean) : [];

  // Upsert tenant_integrations row.
  const { data: integration, error: upsertErr } = await admin
    .from("tenant_integrations")
    .upsert(
      {
        organization_id: state.orgId,
        provider: "nuvemshop",
        oauth_access_token_encrypted: encrypted.data,
        scopes,
        status: "healthy",
        store_metadata: { store_id: storeId },
        webhook_path_token: webhookPathToken,
        webhook_secret_encrypted: webhookSecretEnc.data,
        webhook_subscriptions: {},
        last_sync_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider" },
    ).select("id").single();

  if (upsertErr) {
    await audit({
      action: "nuvemshop.oauth_failed",
      organizationId: state.orgId,
      metadata: { reason: "db_upsert_failed", error: upsertErr.message },
    });
    return redirectTo(`/app/integrations/nuvemshop?error=db_upsert_failed`);
  }

  // Register the 8 webhooks. Best-effort: log failures but don't roll back.
  const subscriptions: Record<string, { id: number | null; error?: string }> = {};
  const baseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const client = new NuvemshopApiClient({ storeId, accessToken });
  for (const event of SUBSCRIBED_EVENTS) {
    const target = `${baseUrl}/api/v1/webhooks/nuvemshop/${eventToSlug(event)}`;
    try {
      const wh = await client.createWebhook(event, target);
      subscriptions[event] = { id: wh.id ?? null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      subscriptions[event] = { id: null, error: msg };
    }
  }

  await admin
    .from("tenant_integrations")
    .update({ webhook_subscriptions: subscriptions })
    .eq("organization_id", state.orgId)
    .eq("provider", "nuvemshop");

  await audit({
    actorUserId: state.userId,
    actorAuthSessionId: state.authSessionId,
    action: "nuvemshop.connected",
    organizationId: state.orgId,
    resourceType: "tenant_integration",
    resourceId: integration?.id,
    requestId: randomUUID(),
    metadata: {
      store_id: storeId,
      scopes,
      webhooks_registered: Object.entries(subscriptions)
        .filter(([, v]) => v.id !== null)
        .map(([k]) => k),
      webhooks_failed: Object.entries(subscriptions)
        .filter(([, v]) => v.id === null)
        .map(([k]) => k),
    },
  });

  return redirectTo(`/app/integrations/nuvemshop?ok=1`);
}
