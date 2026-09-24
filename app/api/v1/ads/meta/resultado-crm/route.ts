import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { relatorioDeCampanhas } from "@/lib/plataformas-de-anuncio/meta/relatorio-servidor";

export const dynamic = "force-dynamic";
const Query = z.object({
  account_id: z.string().regex(/^act_\d+$/),
  from: z.iso.date(),
  to: z.iso.date(),
});
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "ads_insights" });
  if (!auth.ok) return auth.response;
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_failed", "Período inválido.", 422, { requestId });
  const { account_id, from, to } = parsed.data;
  const dias = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (dias < 0 || dias > 90)
    return fail("validation_failed", "Escolha até 90 dias.", 422, { requestId });
  const resultado = await relatorioDeCampanhas({
    organizacao: auth.org.orgId,
    conta: account_id,
    de: from,
    ate: to,
  });
  if (!resultado.ok)
    return fail(
      resultado.causa === "volume" ? "report_too_large" : "upstream_unavailable",
      resultado.causa === "volume"
        ? "Reduza o intervalo: há mais de 5.000 contatos."
        : "Resultados indisponíveis. Tente novamente.",
      resultado.causa === "volume" ? 422 : 503,
      { requestId },
    );
  const response = ok(resultado.dados, { requestId });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
