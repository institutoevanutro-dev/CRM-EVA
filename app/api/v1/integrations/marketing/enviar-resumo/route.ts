import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { EntradaDoResumo, enviarResumo, semanaPermitida } from "@/lib/integrations/marketing/enviar-resumo";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

// O Marketing pede o envio do PDF semanal. Credencial e organização das outras rotas do Marketing;
// 10 pedidos por minuto (o normal é 1 por semana, mais o teste); corpo até ~11 MB (PDF de 8 MB em base64).
export const dynamic = "force-dynamic";
export const maxDuration = 120;
let janela = 0; let pedidos = 0;
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const segredo = process.env.MARKETING_REPORT_TOKEN;
  const recebido = req.headers.get("x-integracao-token");
  if (!segredo || segredo.length < 32 || !recebido || !timingSafeEqual(digest(recebido), digest(segredo)))
    return fail("unauthenticated", "Credencial inválida.", 401, { requestId });
  const org = z.string().uuid().safeParse(process.env.MARKETING_ORGANIZATION_ID);
  if (!org.success) return fail("unavailable", "Integração não configurada.", 503, { requestId });
  const minuto = Math.floor(Date.now() / 60000);
  if (janela !== minuto) { janela = minuto; pedidos = 0; }
  if (++pedidos > 10) return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  if (Number(req.headers.get("content-length") ?? 0) > 12 * 1024 * 1024)
    return fail("validation_failed", "Arquivo grande demais.", 413, { requestId });
  const entrada = EntradaDoResumo.safeParse(await req.json().catch(() => null));
  if (!entrada.success) return fail("validation_failed", "Pedido inválido.", 422, { requestId });
  if (!semanaPermitida(entrada.data.semana)) return fail("validation_failed", "Semana fora do envio desta segunda.", 422, { requestId });
  try {
    const response = ok(await enviarResumo(createAdminClient(), org.data, entrada.data, requestId), { requestId });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    logger.error("[marketing.resumo] rota falhou", { requestId, error: err instanceof Error ? err.message : String(err) });
    return fail("unavailable", "Não consegui enviar agora.", 503, { requestId });
  }
}
