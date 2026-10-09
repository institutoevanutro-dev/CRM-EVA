import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { configPrecificaEva, sincronizarCatalogo } from "@/lib/integrations/precificaeva/catalogo";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Traz os preços do PrecificaEva (fonte única de preço da clínica) para o catálogo do CRM. */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (!provided || !accepted.length || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  // Integração opcional: as três variáveis vazias (como nascem no .env.example) é rodada sem nada a
  // fazer, não falha (o scheduler marcaria FALHOU a cada rodada). Ligada pela metade continua 503.
  if (!env.PRECIFICAEVA_ORGANIZATION_ID && !env.PRECIFICAEVA_URL && !env.PRECIFICAEVA_TOKEN) {
    return ok({ skipped: "not_configured" }, { requestId });
  }
  const org = env.PRECIFICAEVA_ORGANIZATION_ID ?? "";
  const config = configPrecificaEva(env as unknown as Record<string, string | undefined>);
  if (!/^[0-9a-f-]{36}$/i.test(org) || !config) {
    return fail("integration_unavailable", "Integração PrecificaEva indisponível.", 503, { requestId });
  }
  try {
    return ok(await sincronizarCatalogo(createAdminClient(), org, config), { requestId });
  } catch {
    return fail("integration_unavailable", "Sincronização do catálogo indisponível.", 503, { requestId });
  }
}
