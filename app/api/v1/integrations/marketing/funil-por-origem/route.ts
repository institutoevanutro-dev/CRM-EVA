import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { consultaFunilPorOrigem } from "@/lib/integrations/marketing/funil-por-origem";
import { createAdminClient } from "@/lib/supabase/admin";

// Funil por origem para o painel de anúncios. Mesma credencial, organização,
// limite e janela de `financeiro-totais`; só agregados saem daqui.
export const dynamic = "force-dynamic";
let janela = 0; let pedidos = 0;
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const segredo = process.env.MARKETING_REPORT_TOKEN;
  const recebido = req.headers.get("x-integracao-token");
  if (!segredo || segredo.length < 32 || !recebido || !timingSafeEqual(digest(recebido), digest(segredo)))
    return fail("unauthenticated", "Credencial inválida.", 401, { requestId });
  const org = z.string().uuid().safeParse(process.env.MARKETING_ORGANIZATION_ID);
  if (!org.success) return fail("unavailable", "Integração não configurada.", 503, { requestId });
  const minuto = Math.floor(Date.now() / 60000);
  if (janela !== minuto) { janela = minuto; pedidos = 0; }
  if (++pedidos > 60) return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  const parsed = z.object({ de: z.iso.date(), ate: z.iso.date() }).safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success || parsed.data.ate < parsed.data.de ||
      (Date.parse(parsed.data.ate) - Date.parse(parsed.data.de)) / 86400000 > 90)
    return fail("validation_failed", "Período inválido.", 422, { requestId });
  try {
    const response = ok(await consultaFunilPorOrigem(createAdminClient(), org.data, parsed.data.de, parsed.data.ate), { requestId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return fail("unavailable", "Não consegui montar o funil agora.", 503, { requestId });
  }
}
