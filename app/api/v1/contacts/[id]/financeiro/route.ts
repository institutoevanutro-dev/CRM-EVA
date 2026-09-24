import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { configFinanceiro, consultaFinanceiro } from "@/lib/integrations/financeiro/cliente";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "financeiro" });
  if (!auth.ok) return auth.response;
  const id = z
    .string()
    .uuid()
    .safeParse((await ctx.params).id);
  if (!id.success) return fail("validation_failed", "Contato inválido.", 422, { requestId });
  const db = await createClient();
  const { data, error } = await db
    .from("contacts")
    .select("id,is_anonymized")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id.data)
    .maybeSingle();
  if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
  if (!data || data.is_anonymized)
    return fail("not_found", "Contato indisponível.", 404, { requestId });
  const config = configFinanceiro(auth.org.orgId);
  const response = (value: unknown) => {
    const r = ok(value, { requestId });
    r.headers.set("Cache-Control", "no-store");
    return r;
  };
  if (!config) return response({ configurada: false });
  if (!(await checkRateLimit(`financeiro-summary:${auth.org.orgId}`, 120, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  try {
    return response({ configurada: true, ...(await consultaFinanceiro(config, id.data)) });
  } catch {
    return fail(
      "integration_unavailable",
      "Financeiro indisponível. Tente atualizar novamente.",
      503,
      { requestId },
    );
  }
}
