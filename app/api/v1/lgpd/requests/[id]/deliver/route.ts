/**
 * POST /api/v1/lgpd/requests/[id]/deliver
 *
 * "Marcar como entregue". O pedido de dados em `pending_review` tem o relatório
 * pronto e nenhum caminho automático de entrega (titular sem e-mail, ou
 * instalação sem envio de e-mail). A equipe entrega à mão e fecha o pedido aqui.
 * Sem este fecho o pedido nunca sai de `pending_review`, e o vigia de prazo
 * (`cron/lgpd-sla-watcher`, que só ignora `completed` e `failed`) alarma para sempre.
 *
 * Auth: sessão, role >= admin, como as demais rotas de pedido. Organização da sessão.
 *
 * Sem Idempotency-Key: a própria gravação é a trava. O UPDATE só casa com o
 * pedido ainda em `pending_review`, então a segunda chamada devolve 409 e não
 * grava nem audita de novo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { marcarEntregueSchema } from "@/lib/lgpd/pedido-manual";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

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
  const { user, org } = authz;
  const orgId = org.orgId;
  const { id } = await params;

  const parsed = marcarEntregueSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { method } = parsed.data;
  const note = parsed.data.note || null;

  const admin = createAdminClient();
  const { data: pedido, error: erroDaLeitura } = await admin
    .from("lgpd_requests")
    .select("id, request_type, status, result")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroDaLeitura) return fail("internal_error", t("Não foi possível ler a solicitação."), 500, { requestId });
  if (!pedido) return fail("not_found", t("Solicitação não encontrada."), 404, { requestId });

  // Só a ENTREGA de um relatório: anonimização em revisão pendente (sem pegada
  // local, falha parcial) é outro assunto e não se fecha por aqui.
  if (pedido.request_type !== "data_request" || pedido.status !== "pending_review") {
    return fail(
      "state_conflict",
      t("Só um pedido de dados em revisão pendente pode ser marcado como entregue."),
      409,
      { requestId },
    );
  }

  const agora = new Date().toISOString();
  // Gravação CONFERIDA, como as do worker de exportação: o erro é lido, e o
  // filtro por estado faz de uma corrida (dois cliques, worker no meio) um 409.
  const { data: gravadas, error: erroDaGravacao } = await admin
    .from("lgpd_requests")
    .update({
      status: "completed",
      completed_at: agora,
      // O motivo da revisão pendente (ex.: `no_delivery_email`) deixou de valer.
      error_message: null,
      result: {
        ...((pedido.result as Record<string, unknown> | null) ?? {}),
        // Dado da entrega fica no pedido; a auditoria leva só a forma.
        manual_delivery: { by: user.id, at: agora, method, note },
      },
    })
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("status", "pending_review")
    .select("id");

  if (erroDaGravacao) {
    logger.error("[lgpd-deliver] o banco recusou a gravação de estado do pedido", {
      request_id: id.slice(0, 8),
      organization_id: orgId,
      status: "completed",
      error_code: erroDaGravacao.code || "sem_codigo",
    });
    return fail("internal_error", t("Não foi possível marcar como entregue. Tente de novo."), 500, { requestId });
  }
  if (!gravadas?.length) {
    return fail("state_conflict", t("Esta solicitação mudou de estado. Atualize a página."), 409, { requestId });
  }

  await audit({
    action: "lgpd.export_delivered",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: id,
    requestId,
    metadata: { request_id: id, delivery: "manual", method },
  });

  return ok({ request_id: id, status: "completed", completed_at: agora }, { requestId });
}
