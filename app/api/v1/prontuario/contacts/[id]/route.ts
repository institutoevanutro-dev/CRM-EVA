import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isValidCpf } from "@/lib/schemas/contacts";
import { ehIdentificadorTecnico } from "@/lib/contacts/rotulo-do-contato";
import { audit } from "@/lib/audit";
import { validateBearerToken, ensureScope, ensureMcpToolScope, ensureRole, McpAuthError } from "@/lib/mcp/auth";
import { auditarLeitura } from "@/lib/audit/leitura";
import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeProntuario, patchContactSchema, parseBody, crmOperationError, contactForProntuario, structuredAddressForProntuario } from "@/lib/prontuario/contacts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const responseOptions = { requestId, headers: { "Cache-Control": "no-store" } };
  const authorized = await authorizeProntuario(req, "prontuario:contacts:read", requestId);
  if (!authorized.ok) {
    authorized.response.headers.set("Cache-Control", "no-store");
    return authorized.response;
  }
  const query = new URL(req.url).searchParams;
  const include = z.literal("demographics").nullable().safeParse(query.get("include"));
  if (!include.success || query.getAll("include").length > 1)
    return fail("validation_failed", "Inclusão inválida.", 422, responseOptions);
  if (include.data) {
    try {
      ensureScope(authorized.auth.scopes, "prontuario:contacts:demographics:read");
    } catch {
      return fail("forbidden", "Credencial sem acesso aos dados demográficos protegidos.", 403, responseOptions);
    }
  }
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("validation_failed", "Contato inválido.", 422, responseOptions);
  const contactId = id.data;
  const appointmentId = z.uuid().nullable().safeParse(query.get("appointment_id"));
  if (!appointmentId.success) return fail("validation_failed", "Compromisso inválido.", 422, responseOptions);
  if (appointmentId.data) {
    try {
      const agenda = await validateBearerToken(req.headers.get("x-agenda-authorization"));
      ensureMcpToolScope(agenda.scopes, "crm_list_appointments", "mcp:read");
      ensureRole(agenda.role, "agent");
      if (agenda.organizationId !== authorized.auth.organizationId) return fail("forbidden", "Credenciais de organizações diferentes.", 403, responseOptions);
    } catch (error) {
      return fail("forbidden", "Credencial da agenda sem acesso.", error instanceof McpAuthError ? error.httpStatus : 503, responseOptions);
    }
  }
  if (!(await checkRateLimit(`prontuario-contacts-read:${authorized.auth.organizationId}:${authorized.auth.apiTokenId}`, 60, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, responseOptions);
  const db = createAdminClient();
  const { data, error } = await db.from("contacts")
    .select("id,name,display_name,birthdate,phone_number,email,updated_at,cpf_encrypted,custom_fields")
    .eq("organization_id", authorized.auth.organizationId)
    .eq("id", id.data).eq("is_anonymized", false).is("is_merged_into", null).maybeSingle();
  if (error) return fail("internal_error", "Consulta indisponível.", 503, responseOptions);
  if (!data) return fail("not_found", "Contato indisponível.", 404, responseOptions);
  // Observações internas só saem pela integração do prontuário, nunca pelo MCP do assistente.
  let appointment;
  if (appointmentId.data) {
    const org = authorized.auth.organizationId;
    const result = await db.from("calendar_appointments").select("id,title,notes,event_type_id,owner_user_id")
      .eq("organization_id", org).eq("contact_id", id.data).eq("id", appointmentId.data).maybeSingle();
    if (result.error) return fail("internal_error", "Consulta indisponível.", 503, responseOptions);
    if (!result.data) return fail("not_found", "Compromisso indisponível.", 404, responseOptions);
    const row = result.data;
    const [type, member] = await Promise.all([
      row.event_type_id ? db.from("calendar_event_types").select("name").eq("organization_id", org).eq("id", row.event_type_id).maybeSingle() : {data:null,error:null},
      row.owner_user_id ? db.from("user_organizations").select("user_id").eq("organization_id", org).eq("user_id", row.owner_user_id).maybeSingle() : {data:null,error:null},
    ]);
    if (type.error || member.error) return fail("internal_error", "Consulta indisponível.", 503, responseOptions);
    const professional = member.data ? await db.auth.admin.getUserById(member.data.user_id) : null;
    if (professional?.error) return fail("internal_error", "Consulta indisponível.", 503, responseOptions);
    const name = professional?.data.user?.user_metadata?.full_name;
    appointment = {id:row.id,title:row.title,type:type.data?.name ?? null,professional:typeof name === "string" ? name : null,notes:row.notes};
  }
  let demographics;
  if (include.data) {
    let cpf: string | null = null;
    if (data.cpf_encrypted) {
      const decrypted = await db.rpc("decrypt_cpf", { p_contact_id: id.data });
      if (!decrypted.error && typeof decrypted.data === "string" && /^\d{11}$/.test(decrypted.data) && isValidCpf(decrypted.data))
        cpf = decrypted.data;
      await audit({
        action: "contact.cpf_viewed", actorApiTokenId: authorized.auth.apiTokenId,
        organizationId: authorized.auth.organizationId, resourceType: "contact", resourceId: contactId, requestId,
        metadata: { decrypt_purpose: "prontuario_demographics_sync", success: cpf !== null },
      });
      if (!cpf) return fail("internal_error", "Dados demográficos indisponíveis.", 503, responseOptions);
    }
    // A RPC de decifra lê novamente o contato; não entregue revisões misturadas.
    const current = await db.from("contacts").select("updated_at,cpf_encrypted")
      .eq("organization_id", authorized.auth.organizationId).eq("id", id.data)
      .eq("is_anonymized", false).is("is_merged_into", null).maybeSingle();
    if (current.error) return fail("internal_error", "Consulta indisponível.", 503, responseOptions);
    if (!current.data || current.data.updated_at !== data.updated_at || current.data.cpf_encrypted !== data.cpf_encrypted)
      return fail("conflict", "Cadastro mudou durante a consulta. Tente novamente.", 409, responseOptions);
    const name = data.name?.trim() ?? "";
    demographics = {
      name: ehIdentificadorTecnico(name) ? "" : name,
      cpf,
      address_structured: structuredAddressForProntuario(data.custom_fields),
    };
  }
  auditarLeitura({
    action: "prontuario.contact_read", actorApiTokenId: authorized.auth.apiTokenId,
    organizationId: authorized.auth.organizationId, resourceType: "contact", resourceId: contactId, requestId,
    ...(appointment ? {metadata:{appointment_id:appointment.id}} : {}),
  });
  return ok({...contactForProntuario(data), organization_id: authorized.auth.organizationId, ...demographics, ...(appointment ? {appointment} : {})}, responseOptions);
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
  const { data, error } = await createAdminClient().rpc("fn_prontuario_patch_contact_v2", {
    p_org: auth.organizationId,
    p_patient: input.source_patient_id,
    p_contact: id.data,
    p_revision: input.revision,
    p_expected: input.expected_updated_at,
    p_name: input.name,
    p_birth: input.birthdate,
    p_phone: input.phone_number,
    p_email: input.email,
    p_cpf: input.cpf || null,
    p_address: input.address ?? {},
    p_token: auth.apiTokenId,
  });
  if (error) return crmOperationError(error.message, error.code, requestId);
  const result = data as { id: string; updated_at: string; revision: number; applied: boolean };
  if (result.applied) await audit({ action: "prontuario.contact_updated", actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId, resourceType: "contact", resourceId: result.id, requestId,
    metadata: { source_patient_id: input.source_patient_id, revision: input.revision } });
  return ok({ id: result.id, updated_at: result.updated_at, revision: result.revision, applied: result.applied }, { requestId });
}
