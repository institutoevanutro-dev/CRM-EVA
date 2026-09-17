-- 0264 — Bloqueios obrigatórios do fluxo de cobrança de sinal (T+40/T+60).
--
-- O fluxo "EVA | Sinal T+40min" cobra comprovante de depósito depois de uma
-- reserva. Duas coisas faltavam para o executor de follow-up (migration 0263,
-- `lib/followup/bloqueios-obrigatorios.ts`) impedir um lembrete fora do prazo
-- ou de um tipo de consulta que não usa sinal:
--
-- 1. `followup_enrollments` não sabia a qual RESERVA pertence — só ao contato.
--    Sem isso, "T+40 contado da reserva real" e "uma tentativa por reserva"
--    não têm como ser verificados: um contato com duas consultas teria uma
--    única inscrição para as duas.
-- 2. `calendar_event_types` não distinguia "consulta sujeita a sinal" de
--    qualquer outro tipo de compromisso.
--
-- `appointment_id` é NULLABLE de propósito: só os fluxos amarrados a uma
-- reserva (o de sinal) o preenchem; todo fluxo existente, disparado por etapa
-- ou manualmente sem reserva, continua com `null` e o comportamento de hoje.
--
-- O índice único (pointer_id, appointment_id) é o "uma tentativa por reserva":
-- a mesma reserva não pode ter duas inscrições vivas do MESMO fluxo. Parcial
-- em `appointment_id is not null` para não colidir com o índice já existente
-- de (pointer_id, contact_id) nem com fluxos sem reserva.
alter table followup_enrollments
  add column if not exists appointment_id uuid references calendar_appointments(id) on delete set null;

create unique index if not exists idx_followup_enrollments_one_per_appointment
  on followup_enrollments (pointer_id, appointment_id)
  where appointment_id is not null and status in ('active', 'waiting_reply', 'paused_handoff');

alter table calendar_event_types
  add column if not exists requires_signal boolean not null default false;

-- ---- revisão humana de T+60 (lib/followup/revisao-do-sinal.ts) ---------------
--
-- É um item de Central, não uma ação: nasce 'warn', nunca muda etapa, nunca
-- libera horário, nunca marca falta. `ref_kind`='calendar_appointment' e
-- `ref_id` = a reserva — é a chave de idempotência (a leitura confere se já
-- existe um item aberto para a mesma reserva antes de abrir outro).
alter table agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table agent_inbox_items
  add constraint agent_inbox_items_kind_check
  check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'supervision_review',
    'sinal_revisao_humana',
    'other'
  ));
