/**
 * GET /api/v1/integrations/financeiro/products — a tabela de serviços desta
 * organização, só leitura, para o Catálogo do financeiro.
 *
 * Mesmo contrato da exportação de contato (`../contacts/[id]`): Bearer com
 * `mcp:read`, organização derivada do token e comparada com a configurada.
 * O custo (`custo_cents`) NÃO sai: o financeiro tem o próprio custo e margem
 * é dado que não precisa viajar.
 */
import { randomUUID } from "node:crypto";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { ensureRole, ensureScope, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// O financeiro trata lista cortada como "o resto foi desativado". Acima do teto
// a resposta é erro, nunca uma lista parcial com cara de completa.
const TETO = 2000;

export async function GET(req: Request) {
  const requestId = randomUUID();
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    ensureScope(auth.scopes, "mcp:read");
    ensureRole(auth.role, "agent");
    // Este conector é de UMA organização; o token não escolhe o destino financeiro.
    if (auth.organizationId !== process.env.FINANCEIRO_ORGANIZATION_ID)
      return fail("forbidden", "Integração não habilitada nesta organização.", 403, { requestId });
    if (!(await checkRateLimit(`financeiro-products:${auth.organizationId}`, 60, 60)).allowed)
      return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });

    const { data, error } = await createAdminClient()
      .from("catalog_products")
      .select("id,codigo,nome,categoria,preco_cents,moeda,ativo")
      .eq("organization_id", auth.organizationId)
      .order("codigo")
      .limit(TETO + 1);
    if (error) return fail("internal_error", "Consulta indisponível.", 503, { requestId });
    if ((data ?? []).length > TETO)
      return fail("internal_error", "Catálogo grande demais para esta integração.", 503, {
        requestId,
      });

    const response = ok(
      { organization_id: auth.organizationId, produtos: data ?? [] },
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
