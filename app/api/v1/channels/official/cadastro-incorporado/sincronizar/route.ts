/**
 * POST /api/v1/channels/official/cadastro-incorporado/sincronizar — repete o
 * pedido de contatos/histórico (`smb_app_data`) da coexistência. Sem body.
 *
 * Só o que ainda não tem `request_id` é pedido de novo: repetir um pedido aceito
 * duplicaria a importação. A Meta só aceita até 24 h depois do onboarding;
 * depois disso o único caminho é refazer o fluxo pelo botão.
 */
import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { pedirSincronizacao } from "@/lib/channels/meta/cadastro-incorporado";
import {
  dentroDoPrazoDeSincronizacao,
  lerCoexistencia,
  PRAZO_DA_SINCRONIZACAO_MS,
  SINCRONIZACAO_TEM_CONSUMIDOR,
} from "@/lib/channels/meta/coexistencia";
import { gravarCoexistencia } from "@/lib/channels/meta/conectar-canal-oficial";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { metaSessionForOrg } from "@/lib/channels/meta/session";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const sessao = await metaSessionForOrg(orgId);
  if (!sessao?.phoneNumberId) return fail("not_found", t("Nenhum canal oficial conectado."), 404, { requestId });
  const admin = createAdminClient();
  const { data } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", orgId)
    .eq("id", sessao.id)
    .maybeSingle();
  const coex = lerCoexistencia((data as { metadata?: unknown } | null)?.metadata);
  if (!coex) return fail("invalid_request", t("Este canal não foi conectado em coexistência."), 422, { requestId });
  if (!dentroDoPrazoDeSincronizacao(coex.onboarding_em)) {
    return fail(
      "invalid_request",
      t("Passaram 24 horas desde a conexão. Para importar o histórico, desconecte e refaça o fluxo pelo botão."),
      422,
      { requestId },
    );
  }
  // Só a credencial DESTA sessão: a do `.env` pode ser de outro número.
  // Decifra que lança (GUC ausente, banco fora) é o mesmo "sem credencial", não 500.
  const creds = await resolveMetaCreds(admin, { organizationId: orgId, phoneNumberId: sessao.phoneNumberId }).catch((err: unknown) => {
    logger.warn("[cadastro-incorporado] credencial da sessão não decifrou", {
      organization_id: orgId,
      session: sessao.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!creds || creds.source !== "session") return fail("invalid_request", t("sem credencial da sessão"), 422, { requestId });

  // Sem consumidor dos webhooks (Parte A): não pede, grava nulo (ver `SINCRONIZACAO_TEM_CONSUMIDOR`).
  const pedidos = SINCRONIZACAO_TEM_CONSUMIDOR ? { ...coex.pedidos } : { contatos: null, historico: null };
  if (SINCRONIZACAO_TEM_CONSUMIDOR && (!pedidos.contatos || "erro" in pedidos.contatos)) {
    pedidos.contatos = await pedirSincronizacao(creds.token, creds.phoneNumberId, "smb_app_state_sync");
  }
  if (SINCRONIZACAO_TEM_CONSUMIDOR && (!pedidos.historico || "erro" in pedidos.historico)) {
    pedidos.historico = await pedirSincronizacao(creds.token, creds.phoneNumberId, "history");
  }
  await gravarCoexistencia(admin, orgId, sessao.id, { ...coex, pedidos });
  void audit({
    action: "channel.official_sync_requested",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: sessao.id,
    requestId,
    metadata: { pedidos },
  });
  return ok({ pedidos, ate: new Date(new Date(coex.onboarding_em).getTime() + PRAZO_DA_SINCRONIZACAO_MS).toISOString() });
}
