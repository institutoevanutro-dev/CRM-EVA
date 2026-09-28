import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { validateBearerToken, ensureScope, McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { authorizeProntuario, createContactSchema, parseBody, crmOperationError, contactForProntuario } from "@/lib/prontuario/contacts";

export const dynamic = "force-dynamic";

const searchSchema = z.object({
  search: z.string().trim().min(2).max(100).regex(/^[\p{L}\p{N} @.+-]+$/u),
  limit: z.coerce.number().int().min(1).max(10).default(10),
});

const fields = "id,name,display_name,birthdate,phone_number,email,updated_at";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    ensureScope(auth.scopes, "prontuario:contacts:read");
    const url = new URL(req.url);
    const parsed = searchSchema.safeParse({ search: url.searchParams.get("search"), limit: url.searchParams.get("limit") ?? undefined });
    if (!parsed.success) return fail("validation_failed", "Busca inválida.", 422, { requestId });
    if (!(await checkRateLimit(`prontuario-contacts-read:${auth.organizationId}:${auth.apiTokenId}`, 60, 60)).allowed)
      return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
    const term = `%${parsed.data.search}%`;
    const { data, error } = await createAdminClient()
      .from("contacts")
      .select(fields)
      .eq("organization_id", auth.organizationId)
      .eq("is_anonymized", false)
      .is("is_merged_into", null)
      .or(`name.ilike.${term},display_name.ilike.${term},phone_number.ilike.${term},email.ilike.${term}`)
      .limit(parsed.data.limit);
    if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    const response = ok((data ?? []).map(contactForProntuario), { requestId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof McpAuthError)
      return fail(error.httpStatus === 401 ? "unauthenticated" : "forbidden", "Credencial sem acesso.", error.httpStatus, { requestId });
    return fail("internal_error", "Consulta indisponível.", 503, { requestId });
  }
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authorized = await authorizeProntuario(req, "prontuario:contacts:write", requestId);
  if (!authorized.ok) return authorized.response;
  const parsedBody = await parseBody(req, requestId);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createContactSchema.safeParse(parsedBody.body);
  if (!parsed.success) return fail("validation_failed", "Cadastro inválido.", 422, { requestId });
  const { auth } = authorized;
  if (!(await checkRateLimit(`prontuario-contacts-write:${auth.organizationId}:${auth.apiTokenId}`, 30, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  const input = parsed.data;
  const { data, error } = await createAdminClient().rpc("fn_prontuario_create_contact", {
    p_org: auth.organizationId,
    p_patient: input.source_patient_id,
    p_name: input.name,
    p_birth: input.birthdate,
    p_phone: input.phone_number,
    p_email: input.email,
    p_key: input.request_key,
    p_token: auth.apiTokenId,
  });
  if (error) return crmOperationError(error.message, error.code, requestId);
  const result = data as { id: string; updated_at: string; created: boolean };
  if (result.created) await audit({ action: "prontuario.contact_created", actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId, resourceType: "contact", resourceId: result.id, requestId,
    metadata: { source_patient_id: input.source_patient_id } });
  return ok({ id: result.id, organization_id: auth.organizationId, updated_at: result.updated_at, created: result.created }, { status: result.created ? 201 : 200, requestId });
}
