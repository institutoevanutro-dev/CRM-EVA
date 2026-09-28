import { z } from "zod";
import { fail } from "@/lib/api/wrappers";
import { validateBearerToken, ensureScope, McpAuthError } from "@/lib/mcp/auth";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

const birthdate = z.union([z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10),
)]);
const phone = z.union([z.literal(""), z.string().regex(/^\+[1-9]\d{7,14}$/)]);
const profile = z.object({
  name: z.string().trim().min(2).max(200),
  birthdate,
  phone_number: phone,
  email: z.union([z.literal(""), z.email().max(250)]),
});

export const createContactSchema = profile.extend({
  source_patient_id: z.uuid(),
  request_key: z.uuid(),
  confirmed_no_match: z.literal(true),
}).strict();
export const linkContactSchema = z.object({
  source_patient_id: z.uuid(),
  contact_id: z.uuid(),
  expected_updated_at: z.iso.datetime({ offset: true }),
  confirmed: z.literal(true),
}).strict();
export const patchContactSchema = profile.extend({
  source_patient_id: z.uuid(),
  revision: z.number().int().nonnegative(),
  expected_updated_at: z.iso.datetime({ offset: true }),
}).strict();

export function contactForProntuario(contact: { id: string; name: string | null; display_name: string | null; birthdate: string | null; phone_number: string | null; email: string | null; updated_at: string }) {
  return {
    id: contact.id,
    name: nomeDoContato(contact) ?? "",
    birthdate: contact.birthdate,
    phone_number: contact.phone_number,
    email: contact.email,
    updated_at: contact.updated_at,
  };
}

export async function authorizeProntuario(req: Request, scope: "prontuario:contacts:read" | "prontuario:contacts:write", requestId: string) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    ensureScope(auth.scopes, scope);
    return { ok: true as const, auth };
  } catch (error) {
    if (error instanceof McpAuthError)
      return { ok: false as const, response: fail(error.httpStatus === 401 ? "unauthenticated" : "forbidden", "Credencial sem acesso.", error.httpStatus, { requestId }) };
    return { ok: false as const, response: fail("internal_error", "Integração indisponível.", 503, { requestId }) };
  }
}

export async function parseBody(req: Request, requestId: string): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    const raw = await req.text();
    if (raw.length > 10_000) return { ok: false, response: fail("validation_failed", "Conteúdo muito grande.", 413, { requestId }) };
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: fail("validation_failed", "Conteúdo inválido.", 422, { requestId }) };
  }
}

export function crmOperationError(message: string, code: string | undefined, requestId: string): Response {
  if (message.includes("prontuario_token_invalid")) return fail("forbidden", "Credencial sem acesso.", 403, { requestId });
  if (message.includes("prontuario_contact_unavailable") || message.includes("prontuario_link_unavailable") || code === "23503")
    return fail("not_found", "Contato ou vínculo indisponível.", 404, { requestId });
  if (message.includes("prontuario_revision_conflict") || message.includes("prontuario_link_conflict") || message.includes("prontuario_request_conflict") || code === "23505")
    return fail("conflict", "Cadastro ou revisão mudou. Revise antes de tentar novamente.", 409, { requestId });
  if (message.includes("prontuario_input_invalid") || code === "23514" || code === "22007")
    return fail("validation_failed", "Cadastro inválido.", 422, { requestId });
  return fail("internal_error", "Integração indisponível.", 503, { requestId });
}
