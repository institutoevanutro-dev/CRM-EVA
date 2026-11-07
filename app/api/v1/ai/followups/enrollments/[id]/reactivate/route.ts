import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/reactivate (manager+) — reativa a
 * MESMA inscrição encerrada porque o envio foi recusado pelas regras do
 * atendimento (o desfecho da trava de repetição sobre texto fixo legítimo).
 *
 * Body opcional: `{ "node_id": "<nó>" }` — o nó atual (padrão: reenviar o passo
 * recusado) ou um sucessor direto dele no grafo da versão (pular o passo).
 * Recusa: inscrição não cancelada, cancelada por outro motivo, versão do fluxo
 * removida, nó fora do grafo ou contato já em outro follow-up vivo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { reativaEnrollment } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { validaIdDaRota } from "../_id";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ node_id: z.string().min(1).max(200).optional() });

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const invalido = validaIdDaRota(id, requestId);
  if (invalido) return invalido;

  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  // Body ausente é legítimo (reativar no passo atual), então JSON ilegível
  // degrada para "sem escolha", não para 400 — mesma regra do `skip`.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", t("Passo inválido."), 422, { requestId, details: parsed.error.flatten() });
  }

  const resultado = await reativaEnrollment(
    { supabase: await createClient(), admin: createAdminClient(), orgId: org.orgId, userId: user.id, requestId },
    id,
    parsed.data.node_id ?? null,
  );
  if (!resultado.ok) return respostaDaFalha(resultado, requestId, t);

  void audit({
    action: "followup_enrollment.reactivated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: {
      de: resultado.enrollment.current_node_id,
      para: parsed.data.node_id ?? resultado.enrollment.current_node_id,
      motivo_anterior: resultado.enrollment.cancel_reason,
    },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
