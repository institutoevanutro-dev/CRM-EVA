/**
 * "HÁ IA NO AR ATENDENDO ESTA CONVERSA?" — uma pergunta, um lugar.
 *
 * Trazido do upstream (melgarafael/DeskcommCRM, issue #3966) só com a LEITURA,
 * porque o porte do #5176 (`lib/routing/retomada-da-ia.ts`) depende dela. A opção
 * do número "Esperar a IA qualificar" (`channel_routing_policies.ai_wait_minutes`),
 * que lá também mora neste arquivo, NÃO existe neste fork.
 *
 * Só há IA atendendo quando as QUATRO coisas valem:
 *
 *   · existe agente de IA no ar que atende ESTA conversa — quem responde é
 *     `resolverAgenteDaConversa`, a mesma régua do motor (stickiness da conversa
 *     → versão publicada na sessão → agente único da organização);
 *   · a conversa ainda NÃO passou por um handoff: `last_handoff_at` nulo. Quem o
 *     grava é `performHumanHandoff` e quem o limpa é a devolução ao automático;
 *   · o agente não está CALADO (`bot_silenced_until` no futuro);
 *   · não há um humano com a conversa (o worker já corta `alreadyAssigned`
 *     antes; a leitura fica aqui para o motivo não depender de ordem).
 *
 * ## Falha de leitura distribui (falha ABERTA)
 *
 * Se a leitura do agente estourar, a resposta é `false` e a conversa segue para a
 * fila — a mesma escolha de `motivoDoCasoParaRoteamento` (`worker.ts`): não saber
 * não pode virar fila parada para todo mundo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverAgenteDaConversa, type CandidatoDeAgente } from "@/lib/ai/agents/agente-da-conversa";
import { logger } from "@/lib/logger";

/** Os fatos de que a regra precisa. Puro: sem banco, sem relógio implícito. */
export interface FatosDaQualificacao {
  /** Há agente de IA no ar atendendo esta conversa. */
  iaAtendeOCanal: boolean;
  /** A conversa já foi passada para humano (`last_handoff_at` gravado). */
  passouParaHumano: boolean;
  /** O agente está calado agora (`bot_silenced_until` no futuro). */
  agenteCalado: boolean;
  /** A conversa já tem um humano (`assigned_to_user_id`). */
  comHumano: boolean;
}

export function qualificacaoEmCurso(f: FatosDaQualificacao): boolean {
  if (!f.iaAtendeOCanal) return false;
  if (f.passouParaHumano) return false;
  if (f.agenteCalado) return false;
  if (f.comHumano) return false;
  return true;
}

/** `bot_silenced_until > agora` — o mesmo predicado do gate da IA. */
export function silenciadoAgora(ate: string | null, agora: Date): boolean {
  if (ate === null) return false;
  if (ate === "infinity") return true;
  const t = Date.parse(ate);
  if (Number.isNaN(t)) return false;
  return t > agora.getTime();
}

/** Os campos da conversa de que a leitura precisa (select explícito no worker). */
export interface ConversaParaQualificar {
  channel_session_id: string | null;
  active_ai_agent_id: string | null;
  bot_silenced_until: string | null;
  last_handoff_at: string | null;
  assigned_to_user_id: string | null;
}

/**
 * Lê o que falta e aplica a regra: as versões publicadas no número e os
 * candidatos da organização, pela mesma função de resolução do motor — nenhuma
 * regra nova de "quem atende este número" nasce aqui.
 */
export async function lerQualificacaoDaIA(
  supabase: Pick<SupabaseClient, "from">,
  organizationId: string,
  conversa: ConversaParaQualificar,
  agora: Date,
): Promise<boolean> {
  try {
    let versoesPublicadasNaSessao: string[] = [];
    if (conversa.channel_session_id) {
      const { data: versoes, error: versoesErr } = await supabase
        .from("ai_agent_versions")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      if (versoesErr) throw new Error(versoesErr.message);
      versoesPublicadasNaSessao = (versoes ?? []).map((v) => v.id as string);
    }

    const { data: candidatos, error: agentesErr } = await supabase
      .from("ai_agents")
      .select("id, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at")
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (agentesErr) throw new Error(agentesErr.message);

    const { agente } = resolverAgenteDaConversa((candidatos ?? []) as CandidatoDeAgente[], {
      active_ai_agent_id: conversa.active_ai_agent_id,
      versoesPublicadasNaSessao,
    });

    return qualificacaoEmCurso({
      iaAtendeOCanal: agente !== null,
      passouParaHumano: conversa.last_handoff_at !== null,
      agenteCalado: silenciadoAgora(conversa.bot_silenced_until, agora),
      comHumano: conversa.assigned_to_user_id !== null,
    });
  } catch (err) {
    // Falha ABERTA, com rastro: `false` silencioso é indistinguível de "não há
    // agente" — e é justamente o que se investigaria.
    logger.warn("[routing] não consegui ler o agente da conversa — distribuindo como antes", {
      organization_id: organizationId,
      channel_session_id: conversa.channel_session_id,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return false;
  }
}
