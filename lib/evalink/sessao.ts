import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Abre a sessão Supabase normal da pessoa, sem e-mail: gera um magiclink pela API admin e o
 * troca na hora pelo cliente SSR (mesmo caminho token_hash do /auth/confirm), que grava os
 * cookies pelo cookies() do next/headers; o Next os anexa à resposta que a rota devolver.
 */
export async function abrirSessao(email: string): Promise<boolean> {
  const g = await createAdminClient().auth.admin.generateLink({ type: "magiclink", email });
  const hash = g.data?.properties?.hashed_token;
  if (g.error || !hash) return false;
  const v = await (await createClient()).auth.verifyOtp({ type: "magiclink", token_hash: hash });
  return !v.error && !!v.data.session;
}

/** Os mesmos campos de origem que o login por senha grava no audit. */
export function origemDaRequisicao(req: NextRequest) {
  return {
    requestId: req.headers.get("x-request-id"),
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
}
