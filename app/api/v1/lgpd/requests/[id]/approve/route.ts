import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/lgpd/requests/[id]/approve
 *
 * Manually approves an LGPD request that is in 'received' status.
 * Records the approval on the request row, emits the canonical event to
 * event_log, writes audit lgpd.manually_approved, and transitions
 * status → 'processing'.
 *
 * Auth: cookie session, role >= admin.
 * Idempotency-Key header is REQUIRED. Returns 202 on success.
 *
 * ─── A APROVAÇÃO É A ÚNICA AUTORIZAÇÃO DE UMA ANONIMIZAÇÃO ──────────────────
 *
 * O evento não autoriza nada: o `lgpd-redact-worker` e a cascata do banco só
 * anonimizam se a LINHA do pedido provar a aprovação (`request_payload.approval`,
 * regra em `fn_lgpd_recusa_do_redact`, migration 0357). Por isso a ordem aqui é:
 *
 *   1. grava a prova (quem, quando, por quê, para este pedido e este contato),
 *      só sobre o pedido ainda `received`; o estado NÃO muda neste passo;
 *   2. emite o evento;
 *   3. leva o pedido a `processing`, só se ele ainda estiver `received`.
 *
 * A prova vem antes do evento porque o worker pode pegar o evento no mesmo
 * instante: sem a prova gravada ele recusaria e consumiria o evento. Uma queda
 * entre os passos deixa o pedido `received` (dá para aprovar de novo) ou com o
 * evento já na fila (o worker segue sozinho). Dois cliques simultâneos podem
 * emitir dois eventos: a cascata anonimiza uma vez só.
 */
import { randomUUID, createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  approved_reason: z.string().min(10).max(500),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  // Idempotency-Key is required
  const idempotencyKey =
    req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      "missing_idempotency_key",
      t("Header Idempotency-Key é obrigatório."),
      422,
      { requestId },
    );
  }

  const { id } = await params;
  const orgId = activeOrg.orgId;
  const admin = createAdminClient();

  // Parse body
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }

  const { approved_reason } = parsed.data;

  // Idempotency check — endpoint is /lgpd/requests/:id/approve
  const endpoint = `/api/v1/lgpd/requests/${id}/approve`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ id, approved_reason }))
    .digest("hex");

  const { data: existingKey, error: keyLookupErr } = await admin
    .from("idempotency_keys")
    .select("id, response_body, status_code")
    .eq("organization_id", orgId)
    .eq("key", idempotencyKey)
    .eq("endpoint", endpoint)
    .maybeSingle();

  if (keyLookupErr) {
    logger.error("[lgpd-approve] idempotency lookup error", { error_code: keyLookupErr.code });
  }

  if (existingKey) {
    // Return cached result
    const body = existingKey.response_body as Record<string, unknown>;
    return ok(body, {
      requestId,
      status: existingKey.status_code === 202 ? 200 : 200,
    });
  }

  // Fetch the lgpd_request
  const { data: request, error: reqErr } = await admin
    .from("lgpd_requests")
    .select("id, organization_id, request_type, status, contact_id, external_customer_id, due_at, request_payload")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    return fail("internal_error", reqErr.message, 500, { requestId });
  }
  if (!request) {
    return fail("not_found", t("Solicitação não encontrada."), 404, { requestId });
  }

  // Only 'received' can be approved
  if (request.status !== "received") {
    return fail(
      "conflict",
      `Solicitação está em status '${request.status}' — apenas 'received' pode ser aprovada.`,
      409,
      { requestId },
    );
  }

  // Determine event type based on request_type
  const eventType =
    request.request_type === "data_request"
      ? "lgpd.data_request_received"
      : "lgpd.redact_received";

  // 1. A prova da aprovação, na linha do pedido. O formato é o que
  // `fn_lgpd_recusa_do_redact` confere; os três primeiros campos prendem a
  // aprovação a ESTE pedido, ESTA organização e ao contato que o pedido tem agora.
  const approval = {
    request_id: id,
    organization_id: orgId,
    contact_id: request.contact_id,
    approved_by: authUser.id,
    approved_at: new Date().toISOString(),
    approved_reason,
  };
  const { data: provado, error: provaErr } = await admin
    .from("lgpd_requests")
    .update({
      request_payload: {
        ...((request.request_payload as Record<string, unknown> | null) ?? {}),
        approval,
      },
    })
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("status", "received")
    .select("id");

  if (provaErr) {
    logger.error("[lgpd-approve] a aprovação não foi gravada, pedido mantido em received", {
      request_id: id,
      organization_id: orgId,
      error_code: provaErr.code,
    });
    return fail("internal_error", t("Não foi possível registrar a aprovação. Tente aprovar de novo."), 500, {
      requestId,
    });
  }
  if (!provado || provado.length === 0) {
    // Entre a leitura e a gravação o pedido saiu de `received` (outro clique).
    return fail("conflict", t("Esta solicitação já foi aprovada."), 409, { requestId });
  }

  // 2. Emit event to event_log (triggers async worker)
  const { error: emitErr } = await admin.rpc("emit_event", {
    p_event_type: eventType,
    p_entity_kind: "lgpd_request",
    p_entity_id: id,
    p_payload: {
      request_id: id,
      organization_id: orgId,
      manually_approved: true,
      approved_by: authUser.id,
      approved_reason,
      contact_id: request.contact_id,
      external_customer_id: request.external_customer_id,
      due_at: request.due_at,
    } as unknown as Record<string, unknown>,
    p_metadata: {
      manually_approved: true,
      idempotency_key: idempotencyKey,
    },
    p_organization_id: orgId,
  });

  if (emitErr) {
    // Sem o evento nenhum worker pega o pedido, e não existe cron que o recupere:
    // seguir daqui gravaria `processing` num pedido que ninguém vai processar, e
    // a aprovação só aceita `received`, então ele não sairia mais dali. O pedido
    // fica como está e quem aprovou pode tentar de novo.
    logger.error("[lgpd-approve] emit_event falhou, pedido mantido em received", {
      request_id: id,
      organization_id: orgId,
      error_code: emitErr.code,
    });
    return fail(
      "internal_error",
      t("Não foi possível iniciar o processamento. Tente aprovar de novo."),
      500,
      { requestId },
    );
  }

  // 3. Transition status → processing. Só sobre o pedido ainda `received`: o
  // worker pode já tê-lo levado a `processing` ou `completed`, e gravar por cima
  // desfaria o desfecho dele. Se esta gravação falhar o evento já saiu e o
  // worker grava `processing` por conta própria: registra e segue.
  const { error: updateErr } = await admin
    .from("lgpd_requests")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("status", "received");

  if (updateErr) {
    logger.error("[lgpd-approve] pedido aprovado e evento emitido, mas 'processing' não gravou", {
      request_id: id,
      organization_id: orgId,
      error_code: updateErr.code,
    });
  }

  // Audit — fire-and-forget
  void audit({
    action: "lgpd.manually_approved",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: id,
    requestId,
    metadata: {
      approved_reason,
      idempotency_key: idempotencyKey,
      request_type: request.request_type,
    },
  });

  const responseBody = { request_id: id, status: "processing" };

  // Store idempotency result
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await admin
    .from("idempotency_keys")
    .insert({
      organization_id: orgId,
      key: idempotencyKey,
      endpoint,
      request_hash: requestHash,
      response_body: responseBody as unknown as Record<string, unknown>,
      status_code: 202,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  return ok(responseBody, { requestId, status: 200 });
}
