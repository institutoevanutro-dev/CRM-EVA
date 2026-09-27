import { randomUUID } from "node:crypto";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeProntuario, linkContactSchema, parseBody, crmOperationError } from "@/lib/prontuario/contacts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authorized = await authorizeProntuario(req, "prontuario:contacts:write", requestId);
  if (!authorized.ok) return authorized.response;
  const parsedBody = await parseBody(req, requestId);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = linkContactSchema.safeParse(parsedBody.body);
  if (!parsed.success) return fail("validation_failed", "Vínculo inválido.", 422, { requestId });
  const { auth } = authorized;
  if (!(await checkRateLimit(`prontuario-contacts-write:${auth.organizationId}:${auth.apiTokenId}`, 30, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  const input = parsed.data;
  const { data, error } = await createAdminClient().rpc("fn_prontuario_link_existing", {
    p_org: auth.organizationId,
    p_patient: input.source_patient_id,
    p_contact: input.contact_id,
    p_expected: input.expected_updated_at,
    p_token: auth.apiTokenId,
  });
  if (error) return crmOperationError(error.message, error.code, requestId);
  const result = data as { id: string; updated_at: string; linked: boolean };
  if (result.linked) await audit({ action: "prontuario.contact_linked", actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId, resourceType: "contact", resourceId: result.id, requestId,
    metadata: { source_patient_id: input.source_patient_id } });
  return ok({ id: result.id, organization_id: auth.organizationId, updated_at: result.updated_at, linked: result.linked }, { requestId });
}
