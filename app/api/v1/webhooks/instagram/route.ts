/**
 * Webhook do produto Instagram do app da Meta. Um callback para todas as contas
 * conectadas na instalação; roteia por entry.id. Assinatura com o Instagram App
 * Secret. Recusa COM log: a rota do WhatsApp oficial recusava em silêncio, e isso
 * custou uma manhã de diagnóstico em 24/09/2026.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { fail } from "@/lib/api/wrappers";
import { appDaMeta } from "@/lib/channels/meta/app";
import { verificationChallenge, verifyMetaSignature } from "@/lib/channels/meta/webhook";
import { appDoInstagram } from "@/lib/channels/instagram/app";
import { parseWebhookDoInstagram, parseComentariosDoInstagram } from "@/lib/channels/instagram/webhook";
import { sessaoDoInstagramPorConta } from "@/lib/channels/instagram/sessao";
import { ingerirDoInstagram } from "@/lib/channels/instagram/ingest";
import { ingerirComentario } from "@/lib/channels/instagram/comentarios/ingest";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const { verifyToken } = await appDaMeta();
  const desafio = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  // Texto puro, sem wrapper: a Meta só aceita o handshake em texto cru.
  return desafio === null
    ? new NextResponse("forbidden", { status: 403 })
    : new NextResponse(desafio, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const raw = await req.text();
  const { appSecret } = await appDoInstagram();
  if (!appSecret || !verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    // Recusa COM log: a rota do WhatsApp oficial recusava em silêncio (401 mudo),
    // e isso custou uma manhã de diagnóstico em 24/09/2026. Nunca o corpo nem o segredo.
    logger.warn("[instagram.webhook] assinatura recusada", {
      temSegredo: Boolean(appSecret),
      temCabecalho: req.headers.has("x-hub-signature-256"),
    });
    return fail("unauthorized", "invalid_signature", 401, { requestId });
  }

  let corpo: unknown;
  try {
    corpo = JSON.parse(raw);
  } catch {
    // 200: a Meta re-entrega o que não recebe 2xx, e um corpo ilegível não vai
    // melhorar numa re-tentativa. Não é isto que a doutrina de fio quer proteger.
    return NextResponse.json({ received: 0 });
  }

  const admin = createAdminClient();
  let recebidas = 0;
  // Falha de INFRAESTRUTURA (consulta da sessão ou exceção da ingestão) — nunca
  // resolvida no corpo, sempre a responder 500 no fim do lote — versus falha
  // DETERMINÍSTICA (`status: "falhou"` do próprio `ingerirDoInstagram`), que
  // continua respondendo 200: reentregar o mesmo payload não vai mudar o
  // resultado dela. `external_id` (23505) faz a reentrega ser segura nos dois casos.
  let falhaDeInfraestrutura = false;
  for (const evento of parseWebhookDoInstagram(corpo)) {
    try {
      const resultado = await sessaoDoInstagramPorConta(admin, evento.igAccountId);
      if (resultado.status === "erro") {
        falhaDeInfraestrutura = true;
        logger.error("[instagram.webhook] consulta da sessão falhou", { motivo: resultado.motivo, conta: evento.igAccountId });
        continue;
      }
      if (resultado.status === "ausente") {
        logger.info("[instagram.webhook] conta sem conexão ativa", { conta: evento.igAccountId });
        continue;
      }
      const sessao = resultado.sessao;
      const r = await ingerirDoInstagram(admin, evento, sessao);
      if (r.status === "falhou") {
        logger.error("[instagram.webhook] ingestão falhou", { motivo: r.motivo, organizationId: sessao.organizationId });
      }
      if (r.status === "ingerida") recebidas += 1;
    } catch (err) {
      // Uma exceção (Graph API, decrypt, RPC) NÃO pode abortar o `for`: os
      // eventos seguintes do mesmo lote são de OUTRAS pessoas/mensagens e não
      // têm nada a ver com o que quebrou. Loga e segue — o lote inteiro
      // responde 500 no final, para a Meta reentregar só este batch.
      falhaDeInfraestrutura = true;
      logger.error("[instagram.webhook] evento abortou com exceção", {
        conta: evento.igAccountId,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mesmo tratamento de falha do laço de mensagens acima: erro de infraestrutura
  // (consulta da sessão, exceção) marca o lote para 500; falha determinística do
  // próprio insert só loga e segue. Nada de responder o comentário aqui — quem
  // decide responder é o worker (Task 7).
  for (const comentario of parseComentariosDoInstagram(corpo)) {
    try {
      const resultado = await sessaoDoInstagramPorConta(admin, comentario.igAccountId);
      if (resultado.status === "erro") {
        falhaDeInfraestrutura = true;
        logger.error("[instagram.webhook] consulta da sessão falhou (comentário)", { motivo: resultado.motivo, conta: comentario.igAccountId });
        continue;
      }
      if (resultado.status === "ausente") {
        logger.info("[instagram.webhook] conta sem conexão ativa (comentário)", { conta: comentario.igAccountId });
        continue;
      }
      const sessao = resultado.sessao;
      const r = await ingerirComentario(admin, comentario, sessao);
      if (r.status === "falhou") {
        logger.error("[instagram.webhook] ingestão de comentário falhou", { motivo: r.motivo, organizationId: sessao.organizationId });
      }
    } catch (err) {
      falhaDeInfraestrutura = true;
      logger.error("[instagram.webhook] comentário abortou com exceção", {
        conta: comentario.igAccountId,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (falhaDeInfraestrutura) {
    return fail("internal_error", "falha ao processar um ou mais eventos", 500, { requestId });
  }
  return NextResponse.json({ received: recebidas }, { headers: { "X-Request-Id": requestId } });
}
