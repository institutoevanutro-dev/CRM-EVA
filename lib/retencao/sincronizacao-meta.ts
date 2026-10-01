/**
 * Retenção LGPD da sincronização de coexistência (Meta): `meta.history_chunk`
 * guarda a conversa crua em `payload.value` e `meta.state_sync` a agenda do
 * celular em `payload.contatos`. Os workers limpam ao consumir, mas evento
 * morto ou travado nunca é consumido — então, passados 7 dias, QUALQUER status
 * perde o conteúdo pessoal e a linha (o rastro) fica.
 *
 * Só supabase-js (leitura + update por id e organização), sem função SQL nova.
 * ponytail: lotes de 50 por causa do peso do `value`; o teto por rodada drena o resto amanhã.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export const DIAS_DE_PAYLOAD_DA_SINCRONIZACAO = 7;
const LOTE = 50;
const MAX_LOTES = 20;

const ALVOS = [
  { tipo: "meta.history_chunk", campo: "value" },
  { tipo: "meta.state_sync", campo: "contatos" },
] as const;

export async function limparPayloadsDaSincronizacao(admin: SupabaseClient, agora: Date = new Date()): Promise<number> {
  const corte = new Date(agora.getTime() - DIAS_DE_PAYLOAD_DA_SINCRONIZACAO * 86_400_000).toISOString();
  let limpos = 0;
  for (const { tipo, campo } of ALVOS) {
    for (let i = 0; i < MAX_LOTES; i += 1) {
      const { data, error } = await admin
        .from("event_log")
        .select("id, organization_id, payload")
        .eq("event_type", tipo)
        .lt("created_at", corte)
        .not(`payload->>${campo}`, "is", null)
        .limit(LOTE);
      if (error) throw new Error(`limpar ${tipo}: ${error.message}`);
      const linhas = (data ?? []) as Array<{ id: string; organization_id: string; payload: Record<string, unknown> }>;
      let nesteLote = 0;
      for (const l of linhas) {
        const { error: updErr } = await admin
          .from("event_log")
          .update({ payload: { ...l.payload, [campo]: null, limpo_em: agora.toISOString() } })
          .eq("organization_id", l.organization_id)
          .eq("id", l.id);
        if (updErr) {
          logger.warn("[retencao-sincronizacao] payload não limpo", { event: l.id, reason: updErr.message });
        } else nesteLote += 1;
      }
      limpos += nesteLote;
      // Lote incompleto, ou nada limpo (evita laço em linha que falha sempre): acabou por hoje.
      if (linhas.length < LOTE || nesteLote === 0) break;
    }
  }
  return limpos;
}
