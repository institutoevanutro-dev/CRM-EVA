import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { PADRAO_DO_CODIGO, TIPOS_DE_CLIQUE } from "@/lib/leads/codigo-de-clique-google";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Captura do clique do Google Ads pelo site (migration 0400).
 *
 * Público e sem segredo forte: o navegador vê o token. A organização sai do
 * token do PATH (`ad_platform_connections.click_capture_token`), nunca do
 * corpo. O corpo chega como `text/plain` com JSON dentro, para o `fetch
 * keepalive` não disparar preflight no instante em que a página sai para o
 * WhatsApp. Gravado ou já existente → 204 igual, para ninguém sondar códigos.
 * Não audita: é captura anônima de marketing, como um webhook de entrada.
 */
export const dynamic = "force-dynamic";

const MAX_BYTES = 2048;
const TOKEN = /^[0-9a-f]{64}$/;

const idDeClique = z.string().min(10).max(512).regex(/^[\w.\-~]+$/);
const corpo = z
  .object({
    code: z.string().regex(PADRAO_DO_CODIGO),
    gclid: idDeClique.optional(),
    gbraid: idDeClique.optional(),
    wbraid: idDeClique.optional(),
    landing_url: z.string().url().max(1000).optional(),
    clicked_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((c) => TIPOS_DE_CLIQUE.filter((t) => c[t]).length === 1, "exatamente um id de clique");

function cors(req: NextRequest, res: Response): Response {
  const origem = req.headers.get("origin");
  const origens = (process.env.CLIQUE_GOOGLE_ORIGENS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (origem && origens.includes(origem)) {
    res.headers.set("Access-Control-Allow-Origin", origem);
    res.headers.set("Vary", "Origin");
  }
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function OPTIONS(req: NextRequest): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Methods", "POST");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return cors(req, res);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const limite = await checkRateLimit(`clique-google:ip:${ipDoCliente(req.headers) ?? "desconhecido"}`, 30, 60);
  if (!limite.allowed) {
    const res = fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId });
    res.headers.set("Retry-After", "60");
    return cors(req, res);
  }
  if (!TOKEN.test(token)) return cors(req, fail("not_found", "Não encontrado.", 404, { requestId }));

  const texto = await req.text();
  if (texto.length > MAX_BYTES) return cors(req, fail("validation_failed", "Corpo grande demais.", 400, { requestId }));
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    return cors(req, fail("validation_failed", "Corpo inválido.", 400, { requestId }));
  }
  const parsed = corpo.safeParse(json);
  if (!parsed.success) return cors(req, fail("validation_failed", "Corpo inválido.", 400, { requestId }));

  const admin = createAdminClient();
  const { data: conexao, error: erroConexao } = await admin
    .from("ad_platform_connections")
    .select("organization_id")
    .eq("click_capture_token", token)
    .eq("platform", "google_ads")
    .maybeSingle();
  if (erroConexao) return cors(req, fail("unavailable", "Tente de novo.", 503, { requestId }));
  if (!conexao) return cors(req, fail("not_found", "Não encontrado.", 404, { requestId }));

  const c = parsed.data;
  const tipo = TIPOS_DE_CLIQUE.find((t) => c[t])!;
  const { error } = await admin.from("google_click_codes").insert({
    organization_id: conexao.organization_id,
    code: c.code,
    click_id_kind: tipo,
    click_id: c[tipo]!,
    landing_url: c.landing_url ?? null,
    clicked_at: c.clicked_at ?? null,
  });
  // 23505 = o código já existe nesta organização: não sobrescreve, mesma resposta.
  if (error && error.code !== "23505") {
    logger.error("[clique-google] falha ao gravar código", { requestId, error: error.message });
    return cors(req, fail("unavailable", "Tente de novo.", 503, { requestId }));
  }
  return cors(req, new Response(null, { status: 204, headers: { "X-Request-Id": requestId } }));
}
