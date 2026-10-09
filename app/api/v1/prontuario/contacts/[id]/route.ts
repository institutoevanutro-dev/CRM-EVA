import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { validateBearerToken, ensureMcpToolScope, ensureRole, McpAuthError } from "@/lib/mcp/auth";
import { auditarLeitura } from "@/lib/audit/leitura";
import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeProntuario, patchContactSchema, parseBody, crmOperationError, contactForProntuario } from "@/lib/prontuario/contacts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authorized = await authorizeProntuario(req, "prontuario:contacts:read", requestId);
  if (!authorized.ok) return authorized.response;
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("validation_failed", "Contato inválido.", 422, { requestId });
  const appointmentId = z.uuid().nullable().safeParse(new URL(req.url).searchParams.get("appointment_id"));
  if (!appointmentId.success) return fail("validation_failed", "Compromisso inválido.", 422, { requestId });
  if (appointmentId.data) {
    try {
      const agenda = await validateBearerToken(req.headers.get("x-agenda-authorization"));
      ensureMcpToolScope(agenda.scopes, "crm_list_appointments", "mcp:read");
      ensureRole(agenda.role, "agent");
      if (agenda.organizationId !== authorized.auth.organizationId) return fail("forbidden", "Credenciais de organizações diferentes.", 403, {requestId});
    } catch (error) {
      return fail("forbidden", "Credencial da agenda sem acesso.", error instanceof McpAuthError ? error.httpStatus : 503, {requestId});
    }
  }
  if (!(await checkRateLimit(`prontuario-contacts-read:${authorized.auth.organizationId}:${authorized.auth.apiTokenId}`, 60, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  const db = createAdminClient();
  const { data, error } = await db.from("contacts")
    .select("id,name,display_name,birthdate,phone_number,email,updated_at")
    .eq("organization_id", authorized.auth.organizationId)
    .eq("id", id.data).eq("is_anonymized", false).is("is_merged_into", null).maybeSingle();
  if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
  if (!data) return fail("not_found", "Contato indisponível.", 404, { requestId });
  // Observações internas só saem pela integração do prontuário, nunca pelo MCP do assistente.
  let appointment;
  if (appointmentId.data) {
    const org = authorized.auth.organizationId;
    const result = await db.from("calendar_appointments").select("id,title,notes,event_type_id,owner_user_id")
      .eq("organization_id", org).eq("contact_id", id.data).eq("id", appointmentId.data).maybeSingle();
    if (result.error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    if (!result.data) return fail("not_found", "Compromisso indisponível.", 404, { requestId });
    const row = result.data;
    const [type, member] = await Promise.all([
      row.event_type_id ? db.from("calendar_event_types").select("name").eq("organization_id", org).eq("id", row.event_type_id).maybeSingle() : {data:null,error:null},
      row.owner_user_id ? db.from("user_organizations").select("user_id").eq("organization_id", org).eq("user_id", row.owner_user_id).maybeSingle() : {data:null,error:null},
    ]);
    if (type.error || member.error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    const professional = member.data ? await db.auth.admin.getUserById(member.data.user_id) : null;
    if (professional?.error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    const name = professional?.data.user?.user_metadata?.full_name;
    appointment = {id:row.id,title:row.title,type:type.data?.name ?? null,professional:typeof name === "string" ? name : null,notes:row.notes};
  }
  const contactId = id.data;
  auditarLeitura({
    action: "prontuario.contact_read", actorApiTokenId: authorized.auth.apiTokenId,
    organizationId: authorized.auth.organizationId, resourceType: "contact", resourceId: contactId, requestId,
    ...(appointment ? {metadata:{appointment_id:appointment.id}} : {}),
  });
  return ok({...contactForProntuario(data),...(appointment ? {appointment} : {})}, { requestId, headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authorized = await authorizeProntuario(req, "prontuario:contacts:write", requestId);
  if (!authorized.ok) return authorized.response;
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("validation_failed", "Contato inválido.", 422, { requestId });
  const parsedBody = await parseBody(req, requestId);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = patchContactSchema.safeParse(parsedBody.body);
  if (!parsed.success) return fail("validation_failed", "Cadastro inválido.", 422, { requestId });
  const { auth } = authorized;
  if (!(await checkRateLimit(`prontuario-contacts-write:${auth.organizationId}:${auth.apiTokenId}`, 30, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  const input = parsed.data;
  const { data, error } = await createAdminClient().rpc("fn_prontuario_patch_contact", {
    p_org: auth.organizationId,
    p_patient: input.source_patient_id,
    p_contact: id.data,
    p_revision: input.revision,
    p_expected: input.expected_updated_at,
    p_name: input.name,
    p_birth: input.birthdate,
    p_phone: input.phone_number,
    p_email: input.email,
    p_token: auth.apiTokenId,
  });
  if (error) return crmOperationError(error.message, error.code, requestId);
  const result = data as { id: string; updated_at: string; revision: number; applied: boolean };
  if (result.applied) await audit({ action: "prontuario.contact_updated", actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId, resourceType: "contact", resourceId: result.id, requestId,
    metadata: { source_patient_id: input.source_patient_id, revision: input.revision } });
  return ok({ id: result.id, updated_at: result.updated_at, revision: result.revision, applied: result.applied }, { requestId });
}
