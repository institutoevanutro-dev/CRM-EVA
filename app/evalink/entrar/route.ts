import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_LOGIN, COOKIE_VOLTA, configEvalink } from "@/lib/evalink/config";
import { safeNext } from "@/lib/auth/safe-next";
import { inicioDoLogin } from "@/lib/evalink/oidc";
import { AUTH_LIMITS, authRateLimited } from "@/lib/auth/rate-limit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

/**
 * GET /evalink/entrar: manda o navegador para a Conta com state, nonce e PKCE guardados em cookie.
 * `?next=` (só caminho interno, `safeNext`) vai num cookie irmão e é a tela da volta.
 */
export async function GET(req: NextRequest) {
  const c = configEvalink();
  if (!c) return new NextResponse(null, { status: 404 });
  if (await authRateLimited("evalink_entrar", null, AUTH_LIMITS.evalink)) {
    return new NextResponse("Muitas tentativas. Aguarde alguns minutos.", { status: 429 });
  }
  const { url, cookie } = inicioDoLogin(c);
  const res = NextResponse.redirect(url, 302);
  // Lax, não Strict: a volta é uma navegação vinda da Conta, e cookie Strict não viajaria nela.
  res.cookies.set(COOKIE_LOGIN, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/evalink",
    maxAge: 600,
  });
  const voltaPara = safeNext(req.nextUrl.searchParams.get("next"), "");
  res.cookies.set(COOKIE_VOLTA, voltaPara, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/evalink",
    // Sem destino, apaga o de um login anterior que não terminou.
    maxAge: voltaPara ? 600 : 0,
  });
  return res;
}
