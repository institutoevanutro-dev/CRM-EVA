/**
 * REAÇÃO A QUEM PROMETEU A EQUIPE NÃO ABRE SILÊNCIO NOVO.
 *
 * Caso real (anonimizado): às 20:22 a IA abre um caso (`agent_cases`,
 * `awaiting_human`) e diz ao contato que a equipe responde na segunda; às 20:23
 * ele manda só "👍". Esse 👍 era a última mensagem dele, e 30 min depois o
 * fluxo de silêncio o inscrevia como se ele tivesse esfriado — quem esfriou foi
 * a equipe, que ainda não respondeu.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * A varredura de silêncio não inscreve o contato quando valem as duas:
 *  1. na conversa do inbound vencedor havia, no instante dele, um caso
 *     esperando a equipe: início da espera (`espera_desde`, ou `opened_at`)
 *     antes do inbound e há menos de 2 dias úteis dele
 *     (`DIAS_UTEIS_DO_CASO_ABERTO`, a mesma régua do bloqueio de envio), e o
 *     caso ainda `awaiting_human` ou fechado só DEPOIS do inbound;
 *  2. tudo o que ele mandou nessa conversa desde o início da espera até o
 *     inbound é só emoji, reação ou figurinha — o detector de "sem conteúdo"
 *     de `resposta-a-automacao.ts`, mais a figurinha (lá ela conta como envio
 *     deliberado; aqui, logo depois de "a equipe responde", é um "ok").
 *
 * O critério é o CASO, não o texto da IA: regex sobre "a equipe vai te
 * responder" erraria nas variações do modelo. A decisão é sobre o instante do
 * inbound, e por isso é estável — o caso fechado depois não reabre o episódio
 * desse 👍; só uma mensagem nova do contato abre.
 *
 * Falha ABERTA, como a guarda irmã: erro de leitura vira log e a varredura
 * segue como antes (o bloqueio de envio continua de pé como segunda camada).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { DIAS_UTEIS_DO_CASO_ABERTO, fimDosDiasUteis } from "./bloqueios-obrigatorios";
import {
  inboundTemConteudo,
  MEMO_SO_DEPOIS_DE_MS,
  TETO_DO_MEMO,
  type CandidatoDoSilencio,
} from "./resposta-a-automacao";

/** Mais que isto de mensagens dele desde o caso é conversa: segue elegível. */
const TETO_DE_ENTRADAS = 20;

/** Só emoji/pontuação, reação ou figurinha. */
export function soReacao(linha: { type: string | null; body: string | null }): boolean {
  return linha.type === "sticker" || !inboundTemConteudo(linha);
}

async function reagiuACasoAberto(
  admin: SupabaseClient,
  orgId: string,
  fuso: string,
  candidato: CandidatoDoSilencio,
  inboundMs: number,
): Promise<boolean> {
  const casos = await admin
    .from("agent_cases")
    .select("opened_at, espera_desde")
    .eq("organization_id", orgId)
    .eq("conversation_id", candidato.conversationId)
    .lte("opened_at", candidato.inboundAt)
    .or(`status.eq.awaiting_human,closed_at.gt.${candidato.inboundAt}`)
    .order("opened_at", { ascending: false })
    .limit(5);
  if (casos.error) throw new Error(`reacao_a_caso_aberto_query_failed: ${casos.error.message}`);
  const inicios = ((casos.data ?? []) as Array<{ opened_at: string; espera_desde: string | null }>)
    .map((c) => Date.parse(c.espera_desde ?? c.opened_at))
    .filter(
      (t) =>
        Number.isFinite(t) &&
        t <= inboundMs &&
        fimDosDiasUteis(new Date(t), DIAS_UTEIS_DO_CASO_ABERTO, fuso).getTime() > inboundMs,
    );
  if (inicios.length === 0) return false;

  const entradas = await admin
    .from("messages")
    .select("type, body")
    .eq("organization_id", orgId)
    .eq("conversation_id", candidato.conversationId)
    .eq("direction", "inbound")
    .gte("sent_at", new Date(Math.min(...inicios)).toISOString())
    .lte("sent_at", candidato.inboundAt)
    .order("sent_at", { ascending: false })
    .limit(TETO_DE_ENTRADAS);
  if (entradas.error) throw new Error(`reacao_a_caso_aberto_query_failed: ${entradas.error.message}`);
  const linhas = (entradas.data ?? []) as Array<{ type: string | null; body: string | null }>;
  if (linhas.length === 0 || linhas.length >= TETO_DE_ENTRADAS) return false;
  return linhas.every(soReacao);
}

/**
 * Dos candidatos do silêncio, os contatos cujo último inbound foi só uma reação
 * a um caso esperando a equipe. Erro de leitura LANÇA
 * `reacao_a_caso_aberto_query_failed`; a varredura falha aberta. `memo` guarda
 * a decisão por (organização, conversa, inbound) depois de 10 min do inbound.
 */
export async function contatosQueSoReagiramACasoAberto(
  admin: SupabaseClient,
  orgId: string,
  candidatos: CandidatoDoSilencio[],
  memo?: Map<string, boolean>,
): Promise<Set<string>> {
  const excluidos = new Set<string>();
  let fuso: string | undefined;
  for (const candidato of candidatos) {
    const inboundMs = Date.parse(candidato.inboundAt);
    if (!Number.isFinite(inboundMs)) continue;
    const chave = `${orgId}:${candidato.conversationId}:${candidato.inboundAt}`;
    let reagiu = memo?.get(chave);
    if (reagiu === undefined) {
      if (fuso === undefined) {
        const org = await admin.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
        if (org.error) throw new Error(`reacao_a_caso_aberto_query_failed: ${org.error.message}`);
        fuso = fusoUtilizavel((org.data as { timezone?: string | null } | null)?.timezone);
      }
      reagiu = await reagiuACasoAberto(admin, orgId, fuso, candidato, inboundMs);
      if (memo && Date.now() - inboundMs >= MEMO_SO_DEPOIS_DE_MS) {
        // ponytail: zera tudo ao bater o teto, como a guarda irmã.
        if (memo.size >= TETO_DO_MEMO) memo.clear();
        memo.set(chave, reagiu);
      }
    }
    if (reagiu) excluidos.add(candidato.contactId);
  }
  return excluidos;
}
