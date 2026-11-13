import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/migrar-inscricoes  body: { dry_run: boolean }
 *
 * Leva as inscrições VIVAS deste fluxo que ainda andam numa versão antiga para a
 * versão ATIVA — só as seguras (`avaliaMigracao`). Troca apenas `version_id`:
 * status, `next_eval_at` e `updated_at` ficam como estão, e nada é enviado no
 * ato. Cada troca grava um evento `version_migrated` na inscrição.
 *
 * `dry_run: true` só conta, por versão de origem: seguras e não seguras (com o
 * motivo). Idempotente: rodar de novo só alcança quem ainda não está na ativa.
 *
 * Gate = admin: muda o roteiro de muitos pacientes de uma vez.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { migraInscricoesParaVersaoAtiva } from "@/lib/followup/migrar-versao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corpoSchema = z.strictObject({ dry_run: z.boolean() });

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const r = await migraInscricoesParaVersaoAtiva(
    { supabase: await createClient(), orgId: org.orgId, userId: user.id, requestId },
    id,
    { dryRun: parsed.data.dry_run },
  );
  if (!r.ok) {
    if (r.codigo === "nao_encontrado") return fail("not_found", t(r.mensagem), 404, { requestId });
    if (r.codigo === "sem_versao_ativa") return fail("state_conflict", t(r.mensagem), 409, { requestId });
    return fail("internal_error", r.mensagem, 500, { requestId });
  }

  // Dry-run não muda nada — não é mutação, não audita (mesma régua do cron vazio).
  if (!r.dry_run) {
    void audit({
      action: "followup_flow.enrollments_migrated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "followup_flow_pointer",
      resourceId: id,
      requestId,
      metadata: { versao_ativa: r.versao_ativa, totais: r.totais, por_versao: r.por_versao },
    });
  }

  const { ok: _ok, ...dados } = r;
  return ok(dados, { requestId });
}
