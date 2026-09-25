/**
 * GET/POST /api/v1/cron/instagram-token-refresh — o anti-morte da conexão do
 * Instagram: o token de 60 dias não renova sozinho, e sem esta rodada a
 * mensageria morre em silêncio quando ele vence.
 *
 * A rota só autentica e chama a rodada — toda consulta/escrita que nomeia o
 * provider mora em `lib/channels/instagram/renovacao.ts` (`lint:channels`).
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), igual às
 * demais rotas de cron. Agendamento: `docker/scheduler/entrypoint.sh`
 * (self-host) e `vercel.ts` (Vercel Pro) — não há `vercel.json`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { renovarTokensDoInstagram } from "@/lib/channels/instagram/renovacao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function autorizado(req: NextRequest): boolean {
  const cabecalho = req.headers.get("authorization") ?? "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return aceitos.length > 0 && aceitos.some((s) => cabecalho === `Bearer ${s}`);
}

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizado(req)) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "cron secret inválido" } }, { status: 401 });
  }
  const resumo = await renovarTokensDoInstagram(createAdminClient(), new Date());
  return NextResponse.json({ data: resumo });
}

export async function GET(req: NextRequest): Promise<Response> {
  return executar(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return executar(req);
}
