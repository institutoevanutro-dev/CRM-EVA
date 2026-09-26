/**
 * GET/POST /api/v1/cron/comentarios-worker — Task 7 de 9 da feature
 * "comentários no CRM".
 *
 * Borda HTTP fina: autentica (mesmo contrato Bearer de todo cron deste repo)
 * e chama as duas funções puras de `workers/comentarios-worker.ts` com o
 * wiring real. Nenhuma decisão mora aqui.
 *
 *   1. `processarComentariosNovos` — tira `situacao='novo'` da fila e decide
 *      regra vs. IA vs. `esperando_voce` (ver o cabeçalho do worker).
 *   2. `avisarComentariosParados` — o aviso anti-morte: comentário `novo`
 *      parado há mais de 1h abre item na Central, uma vez.
 *
 * NOTA DE DEPLOY: como os demais crons deste repo (self-host), não há
 * `vercel.json` — o agendamento vive no serviço `scheduler` do
 * `docker-compose.prod.yml`, cujo crontab é gerado por
 * `docker/scheduler/entrypoint.sh`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  avisarComentariosParados,
  construirAdminDoAvisoAntiMorteReal,
  construirAdminDoWorkerReal,
  processarComentariosNovos,
} from "@/workers/comentarios-worker";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  let processado: { atendidos: number; esperando: number };
  let avisado: { avisados: number };
  try {
    processado = await processarComentariosNovos(construirAdminDoWorkerReal(admin), agora);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[comentarios-worker] rodada falhou", { error: detail, requestId });
    return fail("internal_error", "Falha ao processar comentários novos.", 500, { requestId });
  }
  try {
    avisado = await avisarComentariosParados(construirAdminDoAvisoAntiMorteReal(admin), agora);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[comentarios-worker] aviso anti-morte falhou", { error: detail, requestId });
    avisado = { avisados: 0 };
  }

  const resultado = { ...processado, ...avisado };

  // Rodada que não fez nada não é mutação e não audita (mesmo critério do
  // recover-stuck-messages e do snooze-watcher).
  if (processado.atendidos + processado.esperando > 0) {
    void audit({
      action: "comment.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }
  if (avisado.avisados > 0) {
    void audit({
      action: "comment.stuck_alert_opened",
      organizationId: null,
      bypassedRls: true,
      metadata: { avisados: avisado.avisados },
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
