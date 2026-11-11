-- Migration 0406 : CAIXA "AVISAR A EQUIPE" NO FOLLOW-UP — kind próprio na Central.
--
-- O nó `notify_team` do construtor de follow-up abre um item na Central
-- (`agent_inbox_items`) apontando para a conversa do contato, e o aviso vai ao
-- celular como os avisos que pedem gente (`somDoAviso`, migration 0404). Nada é
-- enviado ao cliente. Pedido: o pós-consulta que fica sem resposta avisa a
-- equipe para mandar um áudio ao paciente.
--
-- Por que um kind NOVO, e não um que o CHECK já aceita:
--   - `handoff` é contado como "a IA precisou de uma pessoa" no painel de
--     evolução (`app/api/v1/ai/evolution/route.ts`) e o push dele diz "A IA
--     passou uma conversa para a equipe" — os dois seriam mentira aqui;
--   - `other` não deixa o push reconhecer o aviso: o título é o texto livre que
--     quem monta o fluxo escreveu, e `other/conversation` já é usado pela
--     resposta da IA cortada no teto de tokens, que não deve ir ao celular.
--
-- Só a lista cresce: nenhuma linha existente viola a constraint nova, então não
-- há dado a corrigir antes. Idempotente (`drop constraint if exists`). Nenhuma
-- função nova (item 9 da doutrina não é acionado). No `baseline.sql` o valor
-- entra na lista ÚNICA desta constraint (bloco da 0105), não em bloco novo (#159).

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
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
    'instagram_comment_stuck',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'ad_conversion_failing',
    'followup_notify_team',
    'other'
  ));
