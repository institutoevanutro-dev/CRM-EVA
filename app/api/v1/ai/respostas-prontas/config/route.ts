/**
 * PUT /api/v1/ai/respostas-prontas/config — liga/desliga e o limite da trava 1.
 * Upsert na org da SESSÃO (nunca do corpo). A faixa 0,78–0,95 é cobrada aqui
 * (Zod) e no banco (constraint `respostas_prontas_config_limite`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { configRespostasProntasSchema } from "@/lib/respostas-prontas/esquemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "respostas_prontas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = configRespostasProntasSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("respostas_prontas_config")
    .upsert(
      { organization_id: org.orgId, ...parsed.data, updated_at: new Date().toISOString() },
      { onConflict: "organization_id" },
    );
  if (error) return fail("internal_error", t("Erro ao salvar a configuração."), 500, { requestId });

  void audit({
    action: "resposta_pronta.config_changed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "respostas_prontas_config",
    resourceId: org.orgId,
    requestId,
    metadata: parsed.data,
  });
  return ok(parsed.data, { requestId });
}
