import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O INÍCIO da janela que o sync lê — `agora - 1 dia`, o mesmo `window_start` da
 * leitura completa do Google. O FIM (90 dias) não entra: cortar a ida por ele
 * adiaria a criação de um evento marcado para daqui a cinco meses.
 */
const INICIO_DA_JANELA_MS = 24 * 60 * 60 * 1000;

/**
 * Seleção comum do cron e da prova PostgREST; associação antiga também é relida.
 *
 * A FILA DRENA (upstream #4514, issue #4448): sem recorte de status e data, todo
 * compromisso já publicado voltava a cada 5 minutos para sempre, inclusive os
 * encerrados, e cada volta custava uma leitura no Google. `completed` e
 * `no_show` não empurram (`precisaEmpurrarAoGoogle` em lib/agenda/laco.ts); o
 * `cancelled` fica porque é ele que pede a remoção do evento. O recorte mora
 * AQUI, e não na view: `calendar_google_reconcilable_appointments` também serve
 * ao cron de leitura (`agenda-google-sync`). Filtro do PostgREST vale antes do
 * `limit 50`, então linha morta não ocupa o lote.
 */
export function googlePushCandidates(db: SupabaseClient, now = new Date()) {
  return db
    .from("calendar_google_reconcilable_appointments")
    .select("id,organization_id,user_id:owner_user_id")
    .or(
      "needs_google_push.eq.true,and(google_event_id.not.is.null,google_conflict.is.null),google_conflict->resolution.not.is.null",
    )
    .in("status", ["pending", "confirmed", "cancelled"])
    .gt("ends_at", new Date(now.getTime() - INICIO_DA_JANELA_MS).toISOString())
    .lte("google_next_attempt_at", now.toISOString())
    .not("owner_user_id", "is", null)
    .order("google_next_attempt_at")
    .limit(50);
}
