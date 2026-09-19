/**
 * Revisão humana de T+60 — canal SEPARADO da cadência de mensagens.
 *
 * ═══ POR QUE SEPARADO ═══
 *
 * O executor de follow-up (`bloqueios-obrigatorios.ts`) já pára de mandar
 * lembrete em T+60 (`prazo_do_sinal_vencido`). O que falta é o "e agora?": em
 * T+60, alguém devia OLHAR — não o sistema decidir sozinho que o sinal não
 * veio e agir sobre isso. Este módulo só abre um item na Central. Ele NUNCA:
 *
 *   - libera o horário (isso é `agenda-expira-pendentes`, e só para `pending`,
 *     nunca para `confirmed` — uma reserva com sinal pendente pode já estar
 *     `confirmed` por outro motivo, e mexer nela aqui seria a MESMA classe de
 *     erro que a supervisão (spec 20) proíbe: inferir desfecho financeiro);
 *   - marca falta (`no_show` é um FATO do mundo — a pessoa não veio —, nunca
 *     uma inferência de que o sinal não chegou);
 *   - cancela a consulta ou move o card de etapa.
 *
 * ═══ IDEMPOTÊNCIA ═══
 *
 * Um item por reserva: `ref_kind='appointment'`, `ref_id=<reserva>`.
 * O banco serializa a criação com a reserva e revalida elegibilidade.
 * Qualquer aviso anterior, inclusive resolvido, impede reabertura.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { PRAZO_DO_SINAL_MINUTOS } from './bloqueios-obrigatorios';

export interface FatosDaRevisao {
  reserva: { id: string; criada_em: string; consulta_em: string; sujeita_a_sinal: boolean; contact_id: string };
  /** A etapa atual do negócio já bloqueia follow-up (comprovante tratado, consulta agendada…). */
  etapa_atual_trata_o_sinal: boolean;
  /** Já existe um item de Central para esta reserva, inclusive resolvido.
   * Nome legado mantido para compatibilidade dos consumidores da decisão pura. */
  ja_tem_item_aberto: boolean;
}

export type MotivoSemRevisao =
  | 'nao_sujeita_a_sinal'
  | 'comprovante_ja_tratado'
  | 'ja_tem_item_aberto'
  | 'ainda_nao_venceu_o_prazo';

export type DecisaoDaRevisao = { abrir: true } | { abrir: false; motivo: MotivoSemRevisao };

/**
 * Pura: mesma régua de prazo do executor (`PRAZO_DO_SINAL_MINUTOS`, contado da
 * CRIAÇÃO da reserva, nunca depois do início da consulta) — as duas
 * consequências (parar de mandar mensagem, abrir revisão) vencem no mesmo
 * instante, de propósito.
 */
export function decidirRevisaoHumana(fatos: FatosDaRevisao, agora: Date): DecisaoDaRevisao {
  if (!fatos.reserva.sujeita_a_sinal) return { abrir: false, motivo: 'nao_sujeita_a_sinal' };
  if (fatos.etapa_atual_trata_o_sinal) return { abrir: false, motivo: 'comprovante_ja_tratado' };
  if (fatos.ja_tem_item_aberto) return { abrir: false, motivo: 'ja_tem_item_aberto' };
  const prazo = Math.min(
    Date.parse(fatos.reserva.criada_em) + PRAZO_DO_SINAL_MINUTOS * 60_000,
    Date.parse(fatos.reserva.consulta_em),
  );
  if (agora.getTime() < prazo) return { abrir: false, motivo: 'ainda_nao_venceu_o_prazo' };
  return { abrir: true };
}

// ─── leitura + escrita (supabase admin — mesma convenção dos demais crons) ───

export interface ReservaPendenteDeRevisao {
  id: string;
  organization_id: string;
  contact_id: string;
  criada_em: string;
  consulta_em: string;
}

/** Filtra prazo, status, contato, etapa e TODO histórico antes do limite. */
export async function listarReservasVencidas(
  admin: SupabaseClient,
  agora: Date,
  limite: number,
): Promise<ReservaPendenteDeRevisao[]> {
  const { data, error } = await admin.rpc('sinal_listar_revisoes', {
    p_agora: agora.toISOString(), p_limite: limite,
  });
  if (error) throw new Error(`listarReservasVencidas: ${error.message}`);
  return (data ?? []) as ReservaPendenteDeRevisao[];
}

/** Etapa atual do negócio aberto do contato já bloqueia follow-up (comprovante tratado). */
export async function etapaJaTrataOSinal(admin: SupabaseClient, organizationId: string, contactId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('crm_leads')
    .select('crm_stages!inner(blocks_followups)')
    .eq('organization_id', organizationId)
    .eq('contact_id', contactId)
    .eq('status', 'open');
  if (error) throw new Error(`etapaJaTrataOSinal: ${error.message}`);
  const linhas = (data ?? []) as unknown as Array<{ crm_stages: { blocks_followups: boolean } }>;
  return linhas.some((l) => l.crm_stages.blocks_followups === true);
}

export async function jaTemItemAberto(admin: SupabaseClient, organizationId: string, appointmentId: string): Promise<boolean> {
  const { count, error } = await admin
    .from('agent_inbox_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('kind', 'sinal_revisao_humana')
    .eq('ref_kind', 'appointment')
    .eq('ref_id', appointmentId);
  if (error) throw new Error(`jaTemItemAberto: ${error.message}`);
  return (count ?? 0) > 0;
}

/** Retorna true só quando esta chamada realmente criou um aviso. */
export async function abrirItemDeRevisao(admin: SupabaseClient, reserva: ReservaPendenteDeRevisao): Promise<boolean> {
  const { data, error } = await admin.rpc('sinal_abrir_revisao', {
    p_organization_id: reserva.organization_id, p_appointment_id: reserva.id,
  });
  if (error) throw new Error(`abrirItemDeRevisao: ${error.message}`);
  return data === true;
}
