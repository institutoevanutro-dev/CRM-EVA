import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateBearerToken, ensureScope, ensureRole, McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    ensureScope(auth.scopes, "mcp:read");
    ensureRole(auth.role, "agent");
    // Este conector é de UMA organização; o token não escolhe o destino financeiro.
    if (auth.organizationId !== process.env.FINANCEIRO_ORGANIZATION_ID)
      return fail("forbidden", "Integração não habilitada nesta organização.", 403, { requestId });
    if (!(await checkRateLimit(`financeiro-contact:${auth.organizationId}`, 120, 60)).allowed)
      return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
    const id = z
      .string()
      .uuid()
      .safeParse((await ctx.params).id);
    if (!id.success) return fail("validation_failed", "Contato inválido.", 422, { requestId });
    const { data, error } = await createAdminClient()
      .from("contacts")
      .select("id,organization_id,name,display_name,phone_number,email,is_anonymized")
      .eq("organization_id", auth.organizationId)
      .eq("id", id.data)
      .maybeSingle();
    if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    if (!data || data.is_anonymized)
      return fail("not_found", "Contato indisponível.", 404, { requestId });
    const response = ok(
      {
        id: data.id,
        organization_id: auth.organizationId,
        name: rotuloDoContato(data),
        phone: data.phone_number,
        email: data.email,
      },
      { requestId },
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (e) {
    if (e instanceof McpAuthError)
      return fail("unauthenticated", "Credencial sem acesso.", e.httpStatus, { requestId });
    return fail("internal_error", "Consulta indisponível.", 503, { requestId });
  }
}
