/**
 * GET /api/v1/cron/media-retention
 *
 * A retenção de mídia EXECUTADA (migration 0341; porte de
 * melgarafael/DeskcommCRM #1731). Chama `fn_enfileirar_midia_vencida` em
 * tandas: ela põe na `storage_redaction_queue` o arquivo que deve sair (mídia
 * de mensagem e anexo de nota mais velhos que `media_retention_days`, órfãos do
 * bucket), e o cron `storage-redaction` remove pelo Storage API.
 *
 * OPT-IN: a função só age em organização com `media_retention_enforced`
 * ligado na tela (Configurações › Organização). Numa instalação em que ninguém
 * ligou, cada rodada devolve zeros e não escreve nada.
 *
 * Sem auditoria por arquivo, como o `storage-redaction`: o rastro de cada um é
 * a linha da fila. A RODADA audita (`retention.sweep_run`) só quando teve
 * efeito: rodada vazia não é mutação, e a que apaga dado de cliente não pode
 * ser indistinguível dela.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Por chamada da função, em cada categoria. */
const TANDA = 500;
/** Teto de tandas por rodada: 10 × 500 = até 5 mil arquivos por categoria por dia. */
const MAX_TANDAS = 10;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const total = { vencidas: 0, orfas: 0, expurgadas: 0, tandas: 0 };
  for (let i = 0; i < MAX_TANDAS; i++) {
    const { data, error } = await admin.rpc("fn_enfileirar_midia_vencida" as never, { p_limite: TANDA } as never);
    if (error) {
      logger.error("[media-retention] a função falhou", { request_id: requestId, error: error.message });
      // A falha só vira linha de auditoria se a rodada já tinha mexido em algo.
      if (total.vencidas + total.orfas + total.expurgadas > 0) {
        void audit({
          action: "retention.sweep_run",
          organizationId: null,
          bypassedRls: true,
          metadata: { origem: "media-retention", falhou: true, erro: error.message.slice(0, 300), ...total },
          requestId,
        });
      }
      return fail("internal_error", "media_retention_failed", 500, { requestId });
    }
    const r = (data ?? {}) as { vencidas?: number; orfas?: number; expurgadas?: number };
    const vencidas = r.vencidas ?? 0;
    const orfas = r.orfas ?? 0;
    total.vencidas += vencidas;
    total.orfas += orfas;
    total.expurgadas += r.expurgadas ?? 0;
    total.tandas += 1;
    // Tanda incompleta nas duas categorias = não sobrou nada para esta rodada.
    if (vencidas < TANDA && orfas < TANDA) break;
  }

  if (total.vencidas + total.orfas + total.expurgadas > 0) {
    logger.info("[media-retention] arquivos enfileirados para remoção", { request_id: requestId, ...total });
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { origem: "media-retention", ...total },
      requestId,
    });
  }
  return ok(total, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  return GET(req);
}
