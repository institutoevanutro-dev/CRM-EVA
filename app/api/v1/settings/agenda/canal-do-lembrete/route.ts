/**
 * PATCH /api/v1/settings/agenda/canal-do-lembrete — por qual número o lembrete
 * do compromisso sai.
 *
 * Corpo: `{ "channel_session_id": "<uuid>" }` fixa o número; `null` volta ao
 * automático (conversa da reserva → conversa mais recente → primeiro número).
 * Grava `organizations.settings.agenda_lembrete.channel_session_id`, lido pelo
 * cron `agenda-reminder` via `lib/agenda/canal-do-lembrete.ts` — que explica
 * por que a chave NÃO mora em `settings.agenda`.
 *
 * O número tem de ser da organização da sessão, de envio automático e não
 * arquivado. Desconectado é aceito: o cron só o usa enquanto puder enviar, e
 * cai na regra automática quando não pode.
 *
 * Gate = manager+, o mesmo dos tipos de agendamento na tela onde o campo mora.
 * A escrita vai pelo admin client pelo motivo descrito em
 * `settings/routing/route.ts`. A organização vem da sessão, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { canalDoLembreteSchema, lerCanalDoLembrete, settingsComCanalDoLembrete } from "@/lib/agenda/canal-do-lembrete";
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { providersDeEnvioAutomatico } from "@/lib/channels";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ channel_session_id: canalDoLembreteSchema.nullable() });

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
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
  const para = input.channel_session_id;

  if (para) {
    const { data: canal, error: canalErr } = await supabase
      .from("channel_sessions")
      .select("id")
      .eq("id", para)
      .eq("organization_id", activeOrg.orgId)
      .in("provider", [...providersDeEnvioAutomatico()])
      .is("archived_at", null)
      .maybeSingle();
    if (canalErr) return fail("internal_error", canalErr.message, 500, { requestId });
    if (!canal) {
      return fail("validation_failed", "Número não encontrado nesta organização.", 422, { requestId });
    }
  }

  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  // Sem a linha não há o que mesclar: gravar por cima apagaria o resto de `settings`.
  if (readErr || !orgRow) {
    return fail("internal_error", readErr?.message ?? "organização não encontrada", 500, { requestId });
  }

  const de = lerCanalDoLembrete(orgRow.settings);
  const estado = { channel_session_id: para };
  // Mesmo valor que já vale: nada mudou, então não grava nem audita.
  if (de === para) return ok(estado, { requestId });

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: settingsComCanalDoLembrete(orgRow.settings, para) })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "agenda.canal_do_lembrete_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { de, para },
  });

  return ok(estado, { requestId });
}
