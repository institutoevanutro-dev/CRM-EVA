/**
 * /api/v1/webhooks/clinicorp/[token] — a "Gestão de Webhook" da Clinicorp (migration 0434).
 *
 * MODO DE CAPTURA. O payload desse webhook não tem documentação pública e traz o
 * paciente dentro. Antes de supor campo, este receptor só MEDE: guarda o
 * formato do que chegou (caminho → tipo, `lib/agenda/clinicorp/formato.ts`),
 * nunca um valor, e responde 200 para a Clinicorp não dar o endereço por morto.
 * O parser que grava a ocupação por `fn_agenda_clinicorp_gravar` é escrito
 * depois, contra o formato medido aqui.
 *
 * A organização sai do token do PATH: 64 hex gerados em Configurações › Agenda,
 * guardados só como sha256 em `calendar_clinicorp_integrations.webhook_token_hash`.
 * Nada do corpo vai a banco, log, Sentry nem auditoria; o log leva só o id do
 * formato. Não audita: é batida de entrada, como `publico/clique-google`.
 *
 * Aceita GET, POST e PUT: não se sabe se a Clinicorp confere o endereço antes de
 * mandar eventos, nem com que método manda. O método também é medido.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { descreverFormato, lerCorpo, nomesDosCabecalhos, somarFormato } from "@/lib/agenda/clinicorp/formato";
import { fail, ok } from "@/lib/api/wrappers";
import { BodyLimitError, readLimitedBody } from "@/lib/http/limited-body";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Um evento de agendamento é pequeno; 256 KB folga muito e barra abuso. */
const MAX_BYTES = 256 * 1024;
/** Por IP, antes de tocar no banco. A Clinicorp manda de poucos IPs; a folga é para rajada de remarcação. */
const POR_MINUTO = 300;

const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

async function receber(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = randomUUID();

  const limite = await checkRateLimit(`clinicorp-webhook:ip:${ipDoCliente(req.headers) ?? "desconhecido"}`, POR_MINUTO, 60);
  if (!limite.allowed) {
    return fail("rate_limited", "Tente novamente em um minuto.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const token = tokenSchema.safeParse((await ctx.params).token);
  if (!token.success) return fail("not_found", "Não encontrado.", 404, { requestId });
  const hash = createHash("sha256").update(token.data).digest("hex");

  const admin = createAdminClient();
  const { data: integracao, error } = await admin
    .from("calendar_clinicorp_integrations")
    .select("organization_id, webhook_formatos")
    .eq("webhook_token_hash", hash)
    .maybeSingle();
  if (error) return fail("unavailable", "Tente de novo.", 503, { requestId });
  if (!integracao) return fail("not_found", "Não encontrado.", 404, { requestId });

  let texto = "";
  try {
    texto = new TextDecoder().decode(await readLimitedBody(req, MAX_BYTES));
  } catch (erro) {
    const status = erro instanceof BodyLimitError ? erro.status : 400;
    return fail("invalid_body", "Corpo grande demais ou ilegível.", status, { requestId });
  }

  const tipoDeConteudo = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || null;
  const agora = new Date();
  const formatos = somarFormato(
    integracao.webhook_formatos,
    {
      metodo: req.method,
      tipo_de_conteudo: tipoDeConteudo,
      cabecalhos: nomesDosCabecalhos(req.headers),
      linhas: descreverFormato(lerCorpo(texto, tipoDeConteudo)),
    },
    agora,
  );

  // ponytail: ler-somar-gravar sem trava; duas batidas no mesmo instante podem
  // perder uma contagem. Na captura isso não importa; o parser grava por função.
  const { error: erroGravacao } = await admin
    .from("calendar_clinicorp_integrations")
    .update({ webhook_formatos: formatos, webhook_last_received_at: agora.toISOString() })
    .eq("organization_id", integracao.organization_id);
  if (erroGravacao) return fail("unavailable", "Tente de novo.", 503, { requestId });

  logger.info("[clinicorp-webhook] formato capturado", {
    requestId,
    organizationId: integracao.organization_id,
    formato: formatos[0]?.id,
  });
  return ok({ recebido: true }, { requestId });
}

export const GET = receber;
export const POST = receber;
export const PUT = receber;
