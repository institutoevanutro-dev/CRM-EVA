/**
 * T+60 — REVISÃO HUMANA, não ação automática.
 *
 * A reserva sujeita a sinal passou do prazo (T+60 da CRIAÇÃO da reserva,
 * capado no início da consulta — a mesma régua de `bloqueios-obrigatorios.ts`,
 * que já parou de mandar lembrete nesse instante) e ninguém tratou o
 * comprovante. Esta rota abre UM item na Central (`agent_inbox_items`, kind
 * `sinal_revisao_humana`) para uma pessoa olhar.
 *
 * ═══ O QUE ESTA ROTA NÃO FAZ (spec: "sem liberar horário ou marcar falta") ═══
 *
 * Não libera o horário (isso é `agenda-expira-pendentes`, e só para `pending`
 * — uma reserva com sinal pendente pode estar `confirmed` por outro motivo).
 * Não marca falta, não cancela a consulta, não move o card de etapa. É
 * puramente um aviso: o desfecho financeiro/clínico não se infere aqui — a
 * mesma linha da spec 20 (supervisão) vale para este canal também.
 *
 * Idempotente por reserva: `ref_kind='appointment', ref_id=<reserva>`
 * — reentrega do cron não duplica o item.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  abrirItemDeRevisao,
  listarReservasVencidas,
} from "@/lib/followup/revisao-do-sinal";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto por rodada — mesmo motivo de `agenda-expira-pendentes`: fila curta por construção. */
const LIMITE_DA_VARREDURA = 500;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  let candidatas;
  try {
    candidatas = await listarReservasVencidas(admin, agora, LIMITE_DA_VARREDURA);
  } catch (error) {
    logger.error("[sinal-revisao-humana] consulta falhou", { error: (error as Error).message, requestId });
    return fail("internal_error", "Falha ao buscar reservas vencidas.", 500, { requestId });
  }

  let abertos = 0;
  let ignorados = 0;
  for (const reserva of candidatas) {
    try {
      if (!await abrirItemDeRevisao(admin, reserva)) {
        ignorados += 1;
        continue;
      }
      abertos += 1;
    } catch (error) {
      // Uma reserva com falha não derruba a rodada inteira; ela volta na próxima.
      logger.error("[sinal-revisao-humana] falha numa reserva", {
        error: (error as Error).message,
        appointmentId: reserva.id,
        requestId,
      });
    }
  }

  // Mesma lei do audit log: rodada sem efeito não audita.
  if (abertos > 0) {
    await audit({
      action: "followup.sinal_revisao_humana_aberta",
      resourceType: "calendar_appointment",
      requestId,
      metadata: { abertos, examinadas: candidatas.length, ignorados },
    });
  }

  return ok({ examinadas: candidatas.length, abertos, ignorados }, { requestId });
}

export const GET = handle;
export const POST = handle;
