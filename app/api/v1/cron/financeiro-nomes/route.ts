import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { configFinanceiro } from "@/lib/integrations/financeiro/cliente";
import { sincronizarNomesFinanceiro } from "@/lib/integrations/financeiro/sincronizar-nomes";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (!provided || !accepted.length || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const org = env.FINANCEIRO_ORGANIZATION_ID;
  const config = org ? configFinanceiro(org) : null;
  if (!org || !config) {
    return fail("integration_unavailable", "Integração Financeiro indisponível.", 503, { requestId });
  }
  try {
    return ok(await sincronizarNomesFinanceiro(createAdminClient(), org, config), { requestId });
  } catch {
    return fail("integration_unavailable", "Sincronização indisponível.", 503, { requestId });
  }
}
