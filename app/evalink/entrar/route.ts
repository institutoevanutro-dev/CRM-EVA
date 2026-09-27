import { NextResponse } from "next/server";
import { COOKIE_LOGIN, configEvalink } from "@/lib/evalink/config";
import { inicioDoLogin } from "@/lib/evalink/oidc";
import { AUTH_LIMITS, authRateLimited } from "@/lib/auth/rate-limit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

/** GET /evalink/entrar: manda o navegador para a Conta com state, nonce e PKCE guardados em cookie. */
export async function GET() {
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
  return res;
}
