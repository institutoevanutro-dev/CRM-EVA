/**
 * Contatos da agenda do celular (`smb_app_state_sync`, coexistência) → nome de
 * contato que já existe. O webhook só enfileira (`meta.state_sync`); aqui se aplica.
 *
 * Por que não na hora: a regra é update-only (nunca cria contato), e os contatos
 * que o HISTÓRICO ainda vai criar não existem quando a agenda chega. Enquanto o
 * histórico da sessão não fechou (100% ou erro), pede `retry` e aplica uma vez só
 * no fim; passadas 48 h aplica do mesmo jeito. Ao aplicar, `payload.contatos` sai
 * da fila (LGPD: nomes da agenda que não casaram ninguém não ficam em `event_log`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { dentroDoPrazoDeSincronizacao, lerCoexistencia } from "@/lib/channels/meta/coexistencia";
import { upsertContatosDoCelular } from "@/lib/channels/meta/contatos-do-celular";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const META_STATE_SYNC_CONSUMER_KEY = "meta-state-sync-worker";
const PRAZO_MS = 48 * 60 * 60 * 1000;
const REAVALIAR_EM_MS = 5 * 60 * 1000;

const resultado = (status: HandlerResult["status"], detail: string, retry_at?: string): HandlerResult => ({
  consumer_key: META_STATE_SYNC_CONSUMER_KEY,
  status,
  detail,
  ...(retry_at ? { retry_at } : {}),
});

export async function processarStateSync(
  row: EventRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<HandlerResult> {
  const orgId = row.organization_id;
  const contatos = (row.payload as { contatos?: Array<{ waId: string; nome: string | null }> | null }).contatos ?? [];
  const limpar = async () => {
    const { error } = await admin
      .from("event_log")
      .update({ payload: { ...row.payload, contatos: null, limpo_em: new Date().toISOString() } })
      .eq("organization_id", orgId)
      .eq("id", row.id);
    if (error) logger.warn("[meta.state_sync] payload não limpo", { organization_id: orgId, event: row.id, reason: error.message });
  };

  const { data: sessao, error } = row.entity_id
    ? await admin
        .from("channel_sessions")
        .select("metadata, archived_at")
        .eq("organization_id", orgId)
        .eq("id", row.entity_id)
        .maybeSingle()
    : { data: null, error: null };
  if (error) return resultado("error", `sessao: ${error.message}`);
  if (!sessao || (sessao as { archived_at?: string | null }).archived_at) {
    await limpar();
    return resultado("skipped", "sessao_ausente_ou_arquivada");
  }

  const coex = lerCoexistencia((sessao as { metadata?: unknown }).metadata);
  const h = coex?.historico;
  // "Sem histórico por vir": sem coexistência, ou pedido sem request_id e a janela de 24 h já passou.
  const semHistoricoPorVir =
    !coex || (!(coex.pedidos.historico && "request_id" in coex.pedidos.historico) && !dentroDoPrazoDeSincronizacao(coex.onboarding_em));
  const historicoFechou = semHistoricoPorVir || Boolean(h && ((h.progresso ?? 0) >= 100 || h.erro_codigo));
  const idade = Date.now() - Date.parse(row.created_at ?? new Date().toISOString());
  if (!historicoFechou && idade < PRAZO_MS) {
    return resultado("retry", "historico_em_andamento", new Date(Date.now() + REAVALIAR_EM_MS).toISOString());
  }

  const r = await upsertContatosDoCelular(admin, orgId, contatos);
  await limpar();
  return resultado("ok", `processados=${r.processados}`);
}
