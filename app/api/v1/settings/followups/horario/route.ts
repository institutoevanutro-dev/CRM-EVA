/**
 * PATCH /api/v1/settings/followups/horario — o horário de envio dos follow-ups.
 *
 * A janela (`settings.followups.bloqueios.janela`) é respeitada pelo executor
 * desde a migration 0265 e não tinha porta: só dava para ligar com UPDATE à mão.
 * O fuso vem de `organizations.timezone`, nunca do corpo; a regra de escrita é
 * `settingsComJanela`, vizinha da regra que o envio lê.
 *
 * Gate = manager+, o mesmo de editar os fluxos.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { janelaDaTelaSchema, settingsComJanela } from "@/lib/followup/bloqueios-obrigatorios";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ janela: janelaDaTelaSchema });

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(corpoSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = createAdminClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings, timezone")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr || !orgRow) return fail("internal_error", readErr?.message ?? "organização não encontrada", 500, { requestId });

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: settingsComJanela(orgRow.settings, input.janela, orgRow.timezone) })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "followup.horario_de_envio_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { janela: input.janela, timezone: orgRow.timezone },
  });

  return ok({ janela: input.janela, timezone: orgRow.timezone }, { requestId });
}
