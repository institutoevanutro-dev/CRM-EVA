/**
 * PATCH /api/v1/settings/atendimento/pausa-da-ia — quanto tempo a IA fica fora
 * da conversa depois que uma pessoa responde (pelo celular ou pela tela).
 *
 * Grava `organizations.settings.atendimento.pausa_ia_resposta_humana_min`, lido
 * por `lib/escalacao/pausa-por-resposta-humana.ts` nos dois caminhos.
 *
 * Gate = manager+, o mesmo da tela onde o campo mora (Distribuição de
 * atendimento). A escrita vai pelo admin client pelo motivo descrito em
 * `settings/routing/route.ts`: a policy de escrita de `organizations` é só do
 * super-admin, e pelo client de sessão o UPDATE de um gerente casa zero linhas
 * e responde sucesso. A organização vem da sessão, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  lerPausaPorRespostaHumanaMin,
  pausaPorRespostaHumanaSchema,
  settingsComPausaPorRespostaHumana,
} from "@/lib/escalacao/pausa-por-resposta-humana";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ minutos: pausaPorRespostaHumanaSchema });

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_routing" });
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
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  // Sem a linha não há o que mesclar: gravar por cima apagaria o resto de `settings`.
  if (readErr || !orgRow) {
    return fail("internal_error", readErr?.message ?? "organização não encontrada", 500, { requestId });
  }

  // Mesmo valor que já vale: nada mudou, então não grava nem audita.
  const anterior = lerPausaPorRespostaHumanaMin(orgRow.settings);
  if (anterior === input.minutos) return ok({ minutos: input.minutos }, { requestId });

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: settingsComPausaPorRespostaHumana(orgRow.settings, input.minutos) })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "atendimento.pausa_da_ia_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { de_min: anterior, para_min: input.minutos },
  });

  return ok({ minutos: input.minutos }, { requestId });
}
