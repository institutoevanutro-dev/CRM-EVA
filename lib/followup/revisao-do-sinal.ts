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
 * Um item por reserva: `ref_kind='calendar_appointment'`, `ref_id=<reserva>`.
 * A leitura (`lerFatosDaRevisao`) confere se já existe um item ABERTO com essa
 * referência antes de abrir outro — reentrega do cron não duplica.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { PRAZO_DO_SINAL_MINUTOS } from './bloqueios-obrigatorios';

export interface FatosDaRevisao {
  reserva: { id: string; criada_em: string; consulta_em: string; sujeita_a_sinal: boolean; contact_id: string };
  /** A etapa atual do negócio já bloqueia follow-up (comprovante tratado, consulta agendada…). */
  etapa_atual_trata_o_sinal: boolean;
  /** Já existe um item de Central ABERTO para esta reserva. */
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

/**
 * Candidatas: reservas de tipo sujeito a sinal, não canceladas, com contato.
 * O prazo (T+60 da criação, capado no início da consulta) é filtrado AQUI, em
 * aplicação — como `agenda-expira-pendentes` já faz para o prazo por
 * organização —, não no SQL: mantém a régua num lugar só
 * (`decidirRevisaoHumana`), testável sem banco.
 */
export async function listarReservasVencidas(
  admin: SupabaseClient,
  agora: Date,
  limite: number,
): Promise<ReservaPendenteDeRevisao[]> {
  const { data, error } = await admin
    .from('calendar_appointments')
    .select('id, organization_id, contact_id, created_at, starts_at, calendar_event_types!inner(requires_signal)')
    .eq('calendar_event_types.requires_signal', true)
    .neq('status', 'cancelled')
    .not('contact_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limite);
  if (error) throw new Error(`listarReservasVencidas: ${error.message}`);

  const linhas = (data ?? []) as unknown as Array<{
    id: string;
    organization_id: string;
    contact_id: string;
    created_at: string;
    starts_at: string;
  }>;
  return linhas
    .filter((l) => {
      const prazo = Math.min(Date.parse(l.created_at) + PRAZO_DO_SINAL_MINUTOS * 60_000, Date.parse(l.starts_at));
      return agora.getTime() >= prazo;
    })
    .map((l) => ({
      id: l.id,
      organization_id: l.organization_id,
      contact_id: l.contact_id,
      criada_em: new Date(l.created_at).toISOString(),
      consulta_em: new Date(l.starts_at).toISOString(),
    }));
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
    .eq('ref_kind', 'calendar_appointment')
    .eq('ref_id', appointmentId)
    .eq('status', 'open');
  if (error) throw new Error(`jaTemItemAberto: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function abrirItemDeRevisao(admin: SupabaseClient, reserva: ReservaPendenteDeRevisao): Promise<void> {
  const { error } = await admin.from('agent_inbox_items').insert({
    organization_id: reserva.organization_id,
    kind: 'sinal_revisao_humana',
    severity: 'warn',
    title: 'Sinal não confirmado — revisão humana',
    body:
      'A reserva passou do prazo (T+60 da criação, ou início da consulta) sem comprovante tratado. ' +
      'Nenhuma ação automática foi tomada: o horário não foi liberado, a consulta não foi cancelada e falta não foi marcada.',
    ref_kind: 'calendar_appointment',
    ref_id: reserva.id,
  });
  if (error) throw new Error(`abrirItemDeRevisao: ${error.message}`);
}
