/**
 * GET /api/v1/channels/instagram/connect — manda o gestor ao login do Instagram.
 *
 * Aberto pelo NAVEGADOR (botão na tela de Conexões): todo desfecho que não é o
 * gate de papel volta para `/app/connections?instagram=<código>`. O `state` e o
 * cookie de vínculo são os MESMOS da volta do Google (`lib/agenda/google/`):
 * HMAC de `INTERNAL_SECRET`, dez minutos, cookie `SameSite=Lax` preso ao
 * caminho do callback — é ele que prova, na volta, que o navegador é o que saiu.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { emitirEstado } from "@/lib/agenda/google/estado";
import { assinarVinculo, NOME_DO_VINCULO, VALIDADE_DO_VINCULO_S } from "@/lib/agenda/google/vinculo";
import { requireRole } from "@/lib/auth/require-role";
import { appDoInstagram, instagramPodeConectar } from "@/lib/channels/instagram/app";
import {
  CAMINHO_DO_CALLBACK_DO_INSTAGRAM,
  enderecoDeRetornoDoInstagram,
  urlDeLogin,
} from "@/lib/channels/instagram/oauth";
import { env } from "@/lib/env";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function voltar(codigo: string): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return NextResponse.redirect(new URL(`/app/connections?instagram=${codigo}`, base));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;

  const app = await appDoInstagram();
  if (!instagramPodeConectar(app)) return voltar("sem_credencial");

  const nonce = randomBytes(16).toString("base64url");
  let state: string;
  try {
    state = emitirEstado(
      { organizationId: authz.org.orgId, userId: authz.user.id, authSessionId: await authenticatedSessionId() },
      { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce },
    );
  } catch {
    return voltar("falhou");
  }

  const resposta = NextResponse.redirect(urlDeLogin(app.appId!, enderecoDeRetornoDoInstagram(), state));
  resposta.cookies.set(NOME_DO_VINCULO, assinarVinculo(nonce, env.INTERNAL_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_DO_INSTAGRAM,
    maxAge: VALIDADE_DO_VINCULO_S,
  });
  return resposta;
}
