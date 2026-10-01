/**
 * Ciclo de vida da conta pela Meta (coexistência): desconexão pelo celular derruba
 * a sessão e abre o aviso na Central; reconexão devolve `WORKING` e o fecha.
 * O `status_reason` é o que impede a varredura do cron de desfazer a queda.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DETALHE_DESCONECTADO_NO_APP,
  EPISODIO_DESCONECTADO_NO_APP,
  PREFIXO_EMPURRAO,
  STATUS_REASON_DESCONECTADO_NO_APP,
  sincronizarSaudeDaConexao,
} from "@/lib/channels/health";
import { logger } from "@/lib/logger";

import { CHANNEL_PROVIDER_META } from "../capabilities";
import { canonicalPhoneBR } from "../phone-variants";
import type { MetaWebhookSession } from "./session";
import type { AccountEvent } from "./webhook";

export async function aplicarEventoDaConta(
  admin: SupabaseClient,
  sessao: MetaWebhookSession,
  e: AccountEvent,
): Promise<"caiu" | "voltou" | "ignorado"> {
  if (e.evento === "OUTRO") return "ignorado";
  const { data } = await admin
    .from("channel_sessions")
    .select("display_name, phone_number")
    .eq("organization_id", sessao.organizationId)
    .eq("id", sessao.id)
    .maybeSingle();
  // A WABA pode ter mais de um número: evento de OUTRO número não derruba esta sessão.
  const numeroDaSessao = data?.phone_number as string | null | undefined;
  if (e.phoneNumber && numeroDaSessao && canonicalPhoneBR(e.phoneNumber) !== canonicalPhoneBR(numeroDaSessao)) return "ignorado";
  const caiu = e.evento !== "ACCOUNT_RECONNECTED";
  const status = caiu ? "FAILED" : "WORKING";
  const { error } = await admin
    .from("channel_sessions")
    .update({ status, status_reason: caiu ? STATUS_REASON_DESCONECTADO_NO_APP : null, last_status_change_at: new Date().toISOString() })
    .eq("organization_id", sessao.organizationId)
    .eq("id", sessao.id);
  if (error) {
    // Sem a queda gravada, abrir o aviso mentiria; a Meta não re-entrega 200.
    logger.error("[meta.conta] não gravou o estado da sessão", { sessionId: sessao.id, evento: e.evento, detail: error.message });
    return "ignorado";
  }
  if (!caiu) {
    // Reconectar fecha SÓ o aviso que a desconexão abriu: outro episódio
    // (suspensão, token vencido) segue valendo.
    const { data: saudeAtual } = await admin
      .from("channel_session_health")
      .select("escalated_status")
      .eq("organization_id", sessao.organizationId)
      .eq("channel_session_id", sessao.id)
      .maybeSingle();
    if (saudeAtual?.escalated_status !== `${PREFIXO_EMPURRAO}${EPISODIO_DESCONECTADO_NO_APP}`) return "voltou";
  }
  const apelido = (data?.display_name as string | null) ?? (data?.phone_number as string | null) ?? "sem nome";
  await sincronizarSaudeDaConexao(
    admin,
    { id: sessao.id, organization_id: sessao.organizationId, status, provider: CHANNEL_PROVIDER_META },
    caiu
      ? { reachable: false, status: null, detail: `${DETALHE_DESCONECTADO_NO_APP}:${e.motivo ?? ""}` }
      : { reachable: true, status: "WORKING", detail: null },
    apelido,
    "empurrao",
  );
  return caiu ? "caiu" : "voltou";
}
