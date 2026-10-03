/**
 * GET /api/v1/ai/respostas-prontas/metricas?dias=7|30|90 — por clínica (a org
 * da sessão) e período: resolvidas por resposta pronta, respondidas pela IA e
 * custo de IA evitado (estimado). Agregado no banco (`fn_respostas_prontas_metricas`):
 * contar linhas aqui truncaria em max_rows=1000. Leitura: sem auditoria. manager+.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { metricasQuerySchema, resumirAgregado } from "@/lib/respostas-prontas/esquemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "respostas_prontas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const parsed = metricasQuerySchema.safeParse({ dias: req.nextUrl.searchParams.get("dias") ?? undefined });
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  const dias = parsed.data.dias;
  const agora = Date.now();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("fn_respostas_prontas_metricas", {
    p_org: authz.org.orgId,
    p_desde: new Date(agora - dias * 24 * 60 * 60 * 1000).toISOString(),
    p_ate: new Date(agora + 1000).toISOString(),
  });
  const linha = data?.[0];
  if (error || !linha) {
    return fail("internal_error", t("Erro ao ler as perguntas frequentes."), 500, { requestId });
  }
  return ok(
    {
      dias,
      ...resumirAgregado(
        Number(linha.resolvidas),
        Number(linha.respondidas_pela_ia),
        linha.custo_total_cents,
        linha.custo_incompleto,
      ),
    },
    { requestId },
  );
}
