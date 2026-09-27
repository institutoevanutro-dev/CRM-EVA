import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { configEvalink } from "@/lib/evalink/config";
import { conferirAviso } from "@/lib/evalink/aviso";
import { aplicarAviso } from "@/lib/evalink/entrada";
import { origemDaRequisicao } from "@/lib/evalink/sessao";
import { AUTH_LIMITS, authRateLimited } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const Aviso = z.object({
  id: z.string().uuid(),
  sub: z.string().uuid(),
  motivo: z.string().min(1).max(64),
  modulo: z.string().min(1).max(64),
});

const texto = (corpo: string, status: number) =>
  new NextResponse(corpo, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * POST /evalink/aviso: a Conta avisa que o acesso de alguém mudou. Só 200 encerra a entrega;
 * qualquer outra resposta faz a Conta reenviar. Id repetido responde 200 sem efeito.
 */
export async function POST(req: NextRequest) {
  const c = configEvalink();
  if (!c) return new NextResponse(null, { status: 404 });
  if (await authRateLimited("evalink_aviso", null, AUTH_LIMITS.evalink_aviso)) return texto("limite", 429);

  const corpo = await req.text();
  const assinatura = conferirAviso(c.segredoAviso, corpo, req.headers.get("x-evalink-assinatura"));
  if (!assinatura.ok) return texto("assinatura", 401);

  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    return texto("corpo", 400);
  }
  const p = Aviso.safeParse(json);
  if (!p.success || p.data.id !== assinatura.id) return texto("corpo", 400);

  try {
    const r = await aplicarAviso(createAdminClient(), { sub: p.data.sub, avisoId: p.data.id, motivo: p.data.motivo });
    if (r === "feito") {
      await audit({ action: "auth.evalink_aviso", metadata: { motivo: p.data.motivo }, ...origemDaRequisicao(req) });
    }
  } catch (e) {
    logger.error("evalink_aviso_falhou", { erro: e instanceof Error ? e.message : String(e) });
    return texto("erro", 500);
  }
  return texto("ok", 200);
}
