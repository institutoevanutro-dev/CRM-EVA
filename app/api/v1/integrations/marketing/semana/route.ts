import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { consultaSemana } from "@/lib/integrations/marketing/semana";
import { configFinanceiro } from "@/lib/integrations/financeiro/cliente";
import { consultaTotaisMarketing } from "@/lib/integrations/financeiro/totais-marketing";
import { createAdminClient } from "@/lib/supabase/admin";

// Números da semana para o PDF do Marketing. Mesma credencial, organização e limite das outras
// rotas de integração do Marketing; janela de até 31 dias. Só agregados saem daqui.
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
      (Date.parse(parsed.data.ate) - Date.parse(parsed.data.de)) / 86400000 > 31)
    return fail("validation_failed", "Período inválido.", 422, { requestId });
  try {
    const cfg = configFinanceiro(org.data);
    const fin = cfg ? () => consultaTotaisMarketing(cfg, parsed.data.de, parsed.data.ate) : undefined;
    const response = ok(await consultaSemana(createAdminClient(), org.data, parsed.data.de, parsed.data.ate, fin), { requestId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return fail("unavailable", "Não consegui montar a semana agora.", 503, { requestId });
  }
}
