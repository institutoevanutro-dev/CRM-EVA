import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { relatorioDeCampanhas } from "@/lib/plataformas-de-anuncio/meta/relatorio-servidor";

export const dynamic = "force-dynamic";
const Query = z.object({
  account_id: z.string().regex(/^act_\d+$/),
  from: z.iso.date(),
  to: z.iso.date(),
});
let janela = 0;
let pedidos = 0;
const digest = (s: string) => createHash("sha256").update(s).digest();
function autorizado(recebido: string | null) {
  const segredo = process.env.MARKETING_REPORT_TOKEN;
  return (
    !!segredo &&
    segredo.length >= 32 &&
    !!recebido &&
    timingSafeEqual(digest(recebido), digest(segredo))
  );
}

/** O painel Vercel consulta apenas agregados; nenhum contato individual sai. */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizado(req.headers.get("x-integracao-token")))
    return fail("unauthenticated", "Credencial inválida.", 401, { requestId });
  const org = z.string().uuid().safeParse(process.env.MARKETING_ORGANIZATION_ID);
  if (!org.success) return fail("unavailable", "Integração não configurada.", 503, { requestId });
  const minuto = Math.floor(Date.now() / 60000);
  if (janela !== minuto) {
    janela = minuto;
    pedidos = 0;
  }
  if (++pedidos > 60)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_failed", "Período inválido.", 422, { requestId });
  const { account_id, from, to } = parsed.data;
  const dias = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (dias < 0 || dias > 90)
    return fail("validation_failed", "Escolha até 90 dias.", 422, { requestId });
  const resultado = await relatorioDeCampanhas({
    organizacao: org.data,
    conta: account_id,
    de: from,
    ate: to,
  });
  if (!resultado.ok)
    return fail(
      resultado.causa === "volume" ? "report_too_large" : "upstream_unavailable",
      resultado.causa === "volume" ? "Reduza o intervalo." : "Resultados indisponíveis.",
      resultado.causa === "volume" ? 422 : 503,
      { requestId },
    );
  const response = ok(resultado.dados, { requestId });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
