import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_LOGIN, COOKIE_VOLTA, configEvalink } from "@/lib/evalink/config";
import { safeNext } from "@/lib/auth/safe-next";
import { conferirVolta } from "@/lib/evalink/oidc";
import { decidirEntrada } from "@/lib/evalink/entrada";
import { abrirSessao, origemDaRequisicao, temMfaVerificado } from "@/lib/evalink/sessao";
import { AUTH_LIMITS, authRateLimited } from "@/lib/auth/rate-limit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const atributo = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A página que navega a partir do próprio CRM (ver o comentário do GET). */
const paginaQueSegue = (destino: string) => {
  const d = atributo(destino);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${d}"><title>Entrando</title><p><a href="${d}">Continuar</a></p>`;
};

const limparLogin = (res: NextResponse) => {
  for (const nome of [COOKIE_LOGIN, COOKIE_VOLTA]) {
    res.cookies.set(nome, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure(),
      path: "/evalink",
      maxAge: 0,
    });
  }
  return res;
};

/**
 * GET /evalink/volta: a Conta devolve o navegador com `code` e `state`.
 *
 * Sucesso responde 200 com uma página que navega para /app (ou /login/mfa, se a pessoa tem
 * TOTP verificado), e não 303: o cookie de sessão
 * é SameSite=Strict, e um redirect ainda dentro da navegação vinda da Conta chegaria em /app
 * sem ele. A página faz a navegação seguinte partir do próprio CRM.
 */
export async function GET(req: NextRequest) {
  const c = configEvalink();
  if (!c) return new NextResponse(null, { status: 404 });
  if (await authRateLimited("evalink_volta", null, AUTH_LIMITS.evalink)) {
    return new NextResponse("Muitas tentativas. Aguarde alguns minutos.", { status: 429 });
  }
  // Nunca req.url: atrás de proxy o host pode ser o bind interno do contêiner.
  const vai = (caminho: string) => limparLogin(NextResponse.redirect(new URL(caminho, c.appUrl), 303));
  const origem = origemDaRequisicao(req);

  const quem = await conferirVolta(c, {
    code: req.nextUrl.searchParams.get("code"),
    state: req.nextUrl.searchParams.get("state"),
    cookie: req.cookies.get(COOKIE_LOGIN)?.value,
  });
  if (!quem) return vai("/login?evalink=falhou");

  let d: Awaited<ReturnType<typeof decidirEntrada>>;
  try {
    d = await decidirEntrada(createAdminClient(), { sub: quem.sub, email: quem.email, papel: quem.papel, orgPadrao: c.orgPadrao });
  } catch {
    d = { ok: false, motivo: "falhou" };
  }
  if (!d.ok) {
    await audit({ action: "auth.evalink_recusado", metadata: { motivo: d.motivo }, ...origem });
    return vai(`/login?evalink=${d.motivo}`);
  }

  let abriu = false;
  try {
    abriu = await abrirSessao(d.email);
  } catch {
    abriu = false;
  }
  if (!abriu) {
    await audit({ action: "auth.evalink_recusado", actorUserId: d.userId, metadata: { motivo: "falhou", etapa: "sessao" }, ...origem });
    return vai("/login?evalink=falhou");
  }

  let mfa = true;
  try {
    mfa = await temMfaVerificado(d.userId);
  } catch {
    mfa = true;
  }

  await audit({ action: "auth.evalink_login", actorUserId: d.userId, metadata: { papel: quem.papel, mfa }, ...origem });
  // A tela de onde a pessoa veio (auditoria 17/11, item 53), validada de novo na volta: o
  // cookie é nosso, mas `safeNext` é a regra única de destino interno.
  const voltaPara = safeNext(req.cookies.get(COOKIE_VOLTA)?.value, "/app");
  // Quem tem TOTP verificado prova o fator antes, como no login por senha.
  // Só o que quebraria o valor do parâmetro é escapado; `/app` segue legível.
  const destino = mfa ? `/login/mfa?next=${voltaPara.replace(/[%&#+]/g, encodeURIComponent)}` : voltaPara;
  // Os cookies de sessão gravados por abrirSessao (cookies() do next/headers) o Next anexa a
  // ESTA resposta, como faz com o redirect do /auth/confirm.
  return limparLogin(
    new NextResponse(paginaQueSegue(destino), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }),
  );
}
