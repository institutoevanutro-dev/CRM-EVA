/**
 * /api/v1/webhooks/clinicorp/[token] — a "Gestão de Webhook" da Clinicorp (migrations 0434 e 0438).
 *
 * Duas coisas por batida:
 *
 * 1. MEDE o formato do que chegou (caminho → tipo, `lib/agenda/clinicorp/formato.ts`),
 *    nunca um valor. Foi assim que o formato foi conhecido (25/11/2026), e segue
 *    ligado para que um evento novo (agendamento apagado, por exemplo) apareça
 *    em Configurações › Agenda antes de alguém supor o campo dele.
 * 2. GRAVA a ocupação (0438): o evento traz o mesmo documento da API, lido por
 *    `lerEventoDoWebhook` (`lib/agenda/clinicorp/item.ts`), que só deixa sair
 *    início, fim, profissional, clínica, situação e id. Grava por
 *    `fn_agenda_clinicorp_gravar` e concilia a foto importada do relatório
 *    (`fn_agenda_clinicorp_conciliar`): o horário que a cópia passou a conhecer
 *    sai da foto, e nada conta duas vezes.
 *
 * A organização sai do token do PATH: 64 hex gerados em Configurações › Agenda,
 * guardados só como sha256 em `calendar_clinicorp_integrations.webhook_token_hash`.
 * Nada do corpo vai a log nem a Sentry; o log leva o id do formato e se gravou.
 * A auditoria, como a da cópia pela API, registra só a batida que mudou a
 * ocupação, e só contagens.
 *
 * Aceita GET, POST e PUT: a Clinicorp manda POST JSON (medido), mas GET e PUT
 * seguem medidos em vez de recusados.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { descreverFormato, lerCorpo, nomesDosCabecalhos, somarFormato } from "@/lib/agenda/clinicorp/formato";
import { jsonComIdsGrandes, lerEventoDoWebhook } from "@/lib/agenda/clinicorp/item";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { BodyLimitError, readLimitedBody } from "@/lib/http/limited-body";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

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
  const corpo = lerCorpo(texto, tipoDeConteudo);
  const org = integracao.organization_id;
  const agora = new Date();
  const formatos = somarFormato(
    integracao.webhook_formatos,
    {
      metodo: req.method,
      tipo_de_conteudo: tipoDeConteudo,
      cabecalhos: nomesDosCabecalhos(req.headers),
      linhas: descreverFormato(corpo),
    },
    agora,
  );

  // ponytail: ler-somar-gravar sem trava; duas batidas no mesmo instante podem
  // perder uma contagem do formato. A ocupação, abaixo, grava por função.
  const { error: erroGravacao } = await admin
    .from("calendar_clinicorp_integrations")
    .update({ webhook_formatos: formatos, webhook_last_received_at: agora.toISOString() })
    .eq("organization_id", org);
  if (erroGravacao) return fail("unavailable", "Tente de novo.", 503, { requestId });

  // JSON de novo, agora sem arredondar id (o `lerCorpo` serve à medida, não ao id).
  const json = corpo !== null && typeof corpo === "object" && !tipoDeConteudo?.includes("x-www-form-urlencoded");
  let gravados = 0;
  let conciliados = 0;
  if (json) {
    const { data: organizacao } = await admin.from("organizations").select("timezone").eq("id", org).maybeSingle();
    const fuso = fusoUtilizavel((organizacao as { timezone?: string | null } | null)?.timezone);
    const ocupacao = lerEventoDoWebhook(jsonComIdsGrandes(texto), fuso);
    if (ocupacao) {
      const { data, error } = await admin.rpc("fn_agenda_clinicorp_gravar", { p_org: org, p_itens: [ocupacao] });
      // 503: a Clinicorp tenta de novo, e a gravação é idempotente pelo id.
      if (error) return fail("unavailable", "Tente de novo.", 503, { requestId });
      gravados = Number(data ?? 0);
      // A conciliação roda a organização inteira: a que falhar agora a próxima faz.
      const conciliacao = await admin.rpc("fn_agenda_clinicorp_conciliar", { p_org: org });
      if (conciliacao.error) logger.warn("[clinicorp-webhook] conciliação falhou", { requestId, organizationId: org });
      conciliados = Number(conciliacao.data ?? 0);
    }
  }

  if (gravados > 0 || conciliados > 0) {
    void audit({
      action: "agenda.clinicorp_copiada",
      organizationId: org,
      resourceType: "calendar_clinicorp_integration",
      resourceId: integracao.organization_id,
      requestId,
      // Só contagens: nem horário, nem profissional, nem nada do corpo.
      metadata: { origem: "webhook", gravados, conciliados },
    });
  }

  logger.info("[clinicorp-webhook] batida recebida", { requestId, organizationId: org, formato: formatos[0]?.id, gravados });
  return ok({ recebido: true }, { requestId });
}

export const GET = receber;
export const POST = receber;
export const PUT = receber;
