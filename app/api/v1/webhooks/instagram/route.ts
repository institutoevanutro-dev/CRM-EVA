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
import { parseWebhookDoInstagram } from "@/lib/channels/instagram/webhook";
import { sessaoDoInstagramPorConta } from "@/lib/channels/instagram/sessao";
import { ingerirDoInstagram } from "@/lib/channels/instagram/ingest";
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
  for (const evento of parseWebhookDoInstagram(corpo)) {
    const sessao = await sessaoDoInstagramPorConta(admin, evento.igAccountId);
    if (!sessao) {
      logger.info("[instagram.webhook] conta sem conexão ativa", { conta: evento.igAccountId });
      continue;
    }
    const r = await ingerirDoInstagram(admin, evento, sessao);
    if (r.status === "falhou") {
      logger.error("[instagram.webhook] ingestão falhou", { motivo: r.motivo, organizationId: sessao.organizationId });
    }
    if (r.status === "ingerida") recebidas += 1;
  }
  return NextResponse.json({ received: recebidas }, { headers: { "X-Request-Id": requestId } });
}
