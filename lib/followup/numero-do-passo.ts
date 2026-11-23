/**
 * "Enviar pelo número" do passo de envio: o passo sai por OUTRO número, e não
 * pelo da conversa do contato.
 *
 * Caso que originou: o fluxo de silêncio roda num número oficial sem modelos
 * aprovados; do 4º toque em diante a janela de 24h da Meta já fechou, e a
 * clínica quer que esses toques saiam por um número não oficial.
 *
 * Quem decide é o motor, ANTES de enfileirar o envio: aqui só se resolve a
 * conversa nesse número (criando-a pelo MESMO caminho das outras automações,
 * `fn_service_begin` via `beginServiceAtOrigin`) e a fronteira dela vai no job.
 * Daí em diante o envio é o de sempre, e as travas (liberação do número
 * `pre_go_live`/`ai_access`, janela de envio do número, 24h, atendimento humano)
 * são lidas da conversa DESTE número — os dois remetentes (texto fixo inline e
 * `followup-turn`) tiram a conversa da fronteira do job.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { capabilitiesOf, type ChannelProvider } from "@/lib/channels/capabilities";
import { dataNoFuso, inicioDoDia } from "@/lib/relatorios/janela";

import { leitorDeCanal, recusaDoCanal, type Canal, type LeitorDeCanal } from "./canal-do-gatilho";

export const TETO_DE_PRIMEIROS_CONTATOS_PADRAO = 20;

/** `FOLLOWUP_PRIMEIRO_CONTATO_TETO_DIA`; vazio, negativo ou lixo = 20. Zero vale (não abre conversa nova). */
export function tetoDePrimeirosContatos(valor: string | undefined = process.env.FOLLOWUP_PRIMEIRO_CONTATO_TETO_DIA): number {
  const n = Number(valor);
  return valor?.trim() && Number.isInteger(n) && n >= 0 ? n : TETO_DE_PRIMEIROS_CONTATOS_PADRAO;
}

export type EnvioPeloNumero =
  | { kind: "ok"; boundary: ServiceBoundary; criada: boolean }
  | { kind: "recusado"; message: string }
  | { kind: "teto"; ate: Date; usados: number; teto: number };

/** O que a decisão precisa do banco — o Supabase real ou um dublê. Tudo filtrado por organização. */
export interface BancoDoNumero {
  lerCanal: LeitorDeCanal;
  temConversa(org: string, contactId: string, channelSessionId: string): Promise<boolean>;
  /** Conversas 1:1 abertas no número desde `desde` em que o contato ainda não falou. */
  conversasNovasSemResposta(org: string, channelSessionId: string, desde: Date): Promise<number>;
  abrirConversa(org: string, contactId: string, channelSessionId: string): Promise<ServiceBoundary>;
}

export async function conversaNoNumeroDoPasso(
  banco: BancoDoNumero,
  input: { org: string; contactId: string; channelSessionId: string; agora: Date; fuso: string; teto: number },
): Promise<EnvioPeloNumero> {
  const { org, contactId, channelSessionId, agora, fuso, teto } = input;
  const { data, error } = await banco.lerCanal(org, channelSessionId);
  if (error) throw new Error(error.message);
  const recusa = recusaDoCanal(data);
  if (recusa) return { kind: "recusado", message: recusa.message };

  const existia = await banco.temConversa(org, contactId, channelSessionId);
  if (!existia && capabilitiesOf((data as NonNullable<Canal>).provider as ChannelProvider).banRisk) {
    // ponytail: conta e cria sem trava — dois ticks simultâneos passam o teto em 1 ou 2.
    // O teto é anti-ban aproximado; trava exata pede lock por número.
    const hoje = inicioDoDia(dataNoFuso(agora, fuso), fuso);
    const usados = await banco.conversasNovasSemResposta(org, channelSessionId, hoje);
    if (usados >= teto) {
      const amanha = inicioDoDia(dataNoFuso(new Date(hoje.getTime() + 36 * 3_600_000), fuso), fuso);
      return { kind: "teto", ate: amanha, usados, teto };
    }
  }
  return { kind: "ok", boundary: await banco.abrirConversa(org, contactId, channelSessionId), criada: !existia };
}

export function bancoDoNumeroSupabase(admin: SupabaseClient): BancoDoNumero {
  return {
    lerCanal: leitorDeCanal(admin),
    async temConversa(org, contactId, channelSessionId) {
      const { data, error } = await admin
        .from("conversations")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contactId)
        .eq("channel_session_id", channelSessionId)
        .eq("is_group", false)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
    async conversasNovasSemResposta(org, channelSessionId, desde) {
      const { count, error } = await admin
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("channel_session_id", channelSessionId)
        .eq("is_group", false)
        .is("last_inbound_at", null)
        .gte("created_at", desde.toISOString());
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    // O caminho das outras automações (`ensureConversation`): acha, reabre ou cria.
    abrirConversa: (org, contactId, channelSessionId) => beginServiceAtOrigin(admin, org, contactId, channelSessionId),
  };
}
