/**
 * GET /api/v1/channels/instagram/callback — a volta do login do Instagram.
 *
 * Rota PÚBLICA no proxy (`lib/auth/public-paths.ts`): a volta vem de
 * instagram.com e o cookie de sessão (`SameSite=Strict`) não viaja nela. Quem
 * autentica é o `state` assinado (org + usuário + sessão) somado ao cookie de
 * vínculo `SameSite=Lax` emitido no `connect` — o mesmo desenho da volta do
 * Google. A `organization_id` sai SÓ do `state`, nunca da query.
 *
 * Ordem: `error` (desistência não é falha) → `state` → vínculo → suporte →
 * papel ainda manager+ → troca do code → conta → assinatura do webhook → cifra
 * → gravação. Todo desfecho volta por página-ponte (não redirect: o 2º salto
 * de uma cadeia iniciada fora perderia o cookie Strict e deslogaria a pessoa —
 * ver `app/api/v1/agenda/google/callback/route.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { verificarEstado } from "@/lib/agenda/google/estado";
import { NOME_DO_VINCULO, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { audit } from "@/lib/audit";
import { appDoInstagram, instagramPodeConectar } from "@/lib/channels/instagram/app";
import { podeConectarNaOrganizacao, salvarConexaoDoInstagram } from "@/lib/channels/instagram/conexao";
import {
  assinarWebhookDaConta,
  CAMINHO_DO_CALLBACK_DO_INSTAGRAM,
  enderecoDeRetornoDoInstagram,
  lerConta,
  trocarCodePorTokenLongo,
} from "@/lib/channels/instagram/oauth";
import { env } from "@/lib/env";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function voltar(codigo: string): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const destino = new URL(`/app/connections?instagram=${encodeURIComponent(codigo)}`, base).toString();
  const seguro = destino.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const resposta = new NextResponse(
    `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">` +
      `<meta name="robots" content="noindex">` +
      `<noscript><meta http-equiv="refresh" content="0;url=${seguro}"></noscript>` +
      `<title>Voltando…</title></head><body><p>Voltando para as conexões…</p>` +
      `<script>location.replace(${JSON.stringify(destino)})</script>` +
      `<noscript><p><a href="${seguro}">Continuar</a></p></noscript></body></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // A URL desta página traz `code` e `state` da Meta: sem Referer para o
        // destino e sem cópia em cache.
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    },
  );
  resposta.cookies.set(NOME_DO_VINCULO, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_DO_INSTAGRAM,
    maxAge: 0,
  });
  return resposta;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return voltar("cancelado");

  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(url.searchParams.get("state"), { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    estado = null;
  }
  if (!estado || !vinculoConfere(req.cookies.get(NOME_DO_VINCULO)?.value, estado.nonce, env.INTERNAL_SECRET)) {
    return voltar("link_vencido");
  }
  const { organizationId, userId } = estado;
  const code = url.searchParams.get("code");
  if (!code) return voltar("cancelado");

  const admin = createAdminClient();
  if (
    !(await supportCallbackWriteAllowed(organizationId, userId, estado.authSessionId)) ||
    !(await podeConectarNaOrganizacao(admin, organizationId, userId))
  ) {
    return voltar("link_vencido");
  }

  const app = await appDoInstagram();
  if (!instagramPodeConectar(app)) return voltar("sem_credencial");

  let conta: { igAccountId: string; username: string };
  let tokenCifrado: string | null;
  let expiraEm: Date;
  try {
    const troca = await trocarCodePorTokenLongo(
      { appId: app.appId!, appSecret: app.appSecret! },
      code,
      enderecoDeRetornoDoInstagram(),
    );
    expiraEm = troca.expiraEm;
    conta = await lerConta(troca.token);
    await assinarWebhookDaConta(troca.token);
    tokenCifrado = await encryptWebhookSecret(admin, troca.token);
  } catch (err) {
    // As mensagens de `oauth.ts` carregam só etapa + status HTTP, nunca token.
    logger.warn("[instagram.callback] conexão falhou", {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return voltar("falhou");
  }
  if (!tokenCifrado) return voltar("falhou");

  let status: Awaited<ReturnType<typeof salvarConexaoDoInstagram>>["status"];
  try {
    ({ status } = await salvarConexaoDoInstagram(admin, {
      organizationId,
      igAccountId: conta.igAccountId,
      username: conta.username,
      tokenCifrado,
      expiraEm,
      userId,
    }));
  } catch (err) {
    logger.warn("[instagram.callback] gravação falhou", {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return voltar("falhou");
  }
  if (status === "conta_em_outra_organizacao") return voltar("conta_em_outra_organizacao");

  await audit({
    action: "channel.instagram_connected",
    actorUserId: userId,
    actorAuthSessionId: estado.authSessionId,
    organizationId,
    resourceType: "channel_sessions",
    metadata: { username: conta.username, reconexao: status === "atualizada" },
  });
  return voltar("conectado");
}
