-- Task 7 de 9 da feature "comentários no CRM": o worker que tira comentário
-- da fila e decide o que fazer com ele precisa de duas coisas de schema que
-- as tasks 1-6 não previram.
--
-- 1. REIVINDICAÇÃO (lease), não um novo valor de `situacao`. O plano original
--    falava em `situacao='processando'`, e esse valor NÃO existe no
--    vocabulário fechado da migration 0280 (`novo`, `respondido_pela_regra`,
--    `respondido_pela_ia`, `esperando_voce`, `ignorado`) — alargar o CHECK
--    só para marcar "alguém está cuidando disto agora" tornaria o vocabulário
--    permanentemente maior por um estado transitório. Em vez disso, uma
--    coluna de LEASE: `reivindicar` só avança quem está `situacao='novo'` E
--    (nunca reivindicado OU o lease de 10 min já expirou). Uma rodada que
--    morre no meio não tranca a linha para sempre — a rodada seguinte
--    reivindica de novo.
--
-- 2. `agent_inbox_items_kind_check` ganha `instagram_comment_stuck` — o aviso
--    anti-morte que a Task 7 abre para comentário `novo` (reivindicado ou
--    não) parado há mais de 1h. Entra NO BLOCO ÚNICO já existente (a
--    reconstrução mais recente é a 0266), no fim da lista, antes de `other` —
--    doutrina já documentada ali: um segundo bloco quebraria `update.sh` de
--    clone com vocabulário posterior (issue #159).
alter table public.instagram_comments
  add column if not exists reivindicado_em timestamptz;

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
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
    'instagram_comment_stuck',
    'other'
  ));
