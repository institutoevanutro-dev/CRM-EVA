-- 0391 · Avisar Meta e Google quando um paciente agenda — e só isso.
--
-- O eixo de conversões (0213) nasceu para a VENDA: `lead.won` virava `Purchase`
-- com valor. Este passo troca o evento por um só, "agendou", e o deixa
-- desligado por organização. O valor, o nome da etapa e qualquer coisa sobre o
-- atendimento deixam de sair: numa clínica eles dizem o que o paciente foi
-- tratar.
--
-- O que muda no schema:
--   1. Conexão ligada para a venda é DESLIGADA uma vez (a decisão de mandar
--      agendamento é nova e é de quem administra).
--   2. `ad_platform_connections` ganha as colunas do Google Ads (segredos
--      cifrados em bytea).
--   3. `ad_conversion_dispatches` ganha `appointment_id`, tentativas, horários
--      e código de erro, com índice único por (agendamento, plataforma, evento).
--   4. `agent_inbox_items` ganha o kind `ad_conversion_failing`, com um aviso
--      aberto por organização.
--
-- Nenhuma função nova. Nenhuma tabela nova. As duas tabelas seguem deny-all.

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
    'other'
  ));

-- 1. A conexão que estava ligada para a VENDA não passa a mandar agendamento
--    sem alguém decidir. Roda só na PRIMEIRA aplicação: a guarda é a coluna do
--    Google ainda não existir. Reaplicar depois nunca desliga nada.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'ad_platform_connections'
       and column_name = 'google_customer_id'
  ) then
    update public.ad_platform_connections set enabled = false where enabled;
  end if;
end
$$;

-- 2. O Google na mesma linha por plataforma (o índice único é
--    (organization_id, platform)). Os segredos em bytea, cifrados por
--    fn_encrypt_oauth, como o token da Meta. O resto é identificador de conta.
alter table public.ad_platform_connections
  add column if not exists google_customer_id text,
  add column if not exists google_login_customer_id text,
  add column if not exists google_conversion_action_id text,
  add column if not exists google_oauth_client_id text,
  add column if not exists google_oauth_client_secret_encrypted bytea,
  add column if not exists google_refresh_token_encrypted bytea,
  add column if not exists google_developer_token_encrypted bytea;

comment on column public.ad_platform_connections.google_refresh_token_encrypted is
  'Refresh token OAuth do Google Ads da organização (migration 0391), cifrado por fn_encrypt_oauth. Nunca volta para a tela.';
comment on column public.ad_platform_connections.google_developer_token_encrypted is
  'Developer token da API do Google Ads (migration 0391), cifrado por fn_encrypt_oauth.';
comment on column public.ad_platform_connections.google_oauth_client_secret_encrypted is
  'Segredo do cliente OAuth usado para renovar o refresh token (migration 0391), cifrado por fn_encrypt_oauth.';

-- 3. O livro-razão passa a ter uma linha por (agendamento, plataforma). A linha
--    antiga, de venda, continua com lead_id; a nova nasce com appointment_id.
--    Nenhuma coluna guarda dado do paciente: status, motivo, código de erro,
--    tentativas e horários.
alter table public.ad_conversion_dispatches alter column lead_id drop not null;

alter table public.ad_conversion_dispatches
  add column if not exists appointment_id uuid
    references public.calendar_appointments(id) on delete cascade,
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists error_code text;

-- Criada só quando falta: drop + add abriria uma janela sem a regra a cada
-- reaplicação do baseline (`reaplicar-o-baseline-nao-abre-janela.test.ts`).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ad_conversion_dispatches_alvo'
       and conrelid = 'public.ad_conversion_dispatches'::regclass
  ) then
    alter table public.ad_conversion_dispatches
      add constraint ad_conversion_dispatches_alvo
      check (lead_id is not null or appointment_id is not null);
  end if;
end
$$;

-- Dedup ANTES do índice único (doutrina de migrations §8): fica a linha
-- enviada, e entre iguais a mais recente.
delete from public.ad_conversion_dispatches a
 using (
   select id, row_number() over (
            partition by organization_id, appointment_id, platform, event_name
            order by (status = 'sent') desc, attempted_at desc, id desc
          ) as n
     from public.ad_conversion_dispatches
    where appointment_id is not null
 ) d
 where a.id = d.id and d.n > 1;

create unique index if not exists ad_conversion_dispatches_agendamento_uk
  on public.ad_conversion_dispatches (organization_id, appointment_id, platform, event_name)
  where appointment_id is not null;

comment on column public.ad_conversion_dispatches.appointment_id is
  'O agendamento que gerou o aviso (migration 0391). Um aviso por agendamento e plataforma: o índice único parcial impede o segundo envio.';
comment on column public.ad_conversion_dispatches.error_code is
  'Código curto do erro (HTTP ou da plataforma). Nunca a resposta inteira, que pode repetir dado enviado.';

-- 4. O aviso na Central quando o envio para de sair: um aberto por organização.
--    O kind entra na lista ÚNICA de agent_inbox_items_kind_check, lá em cima.
create unique index if not exists agent_inbox_ad_conversion_failing_aberto
  on public.agent_inbox_items (organization_id)
  where kind = 'ad_conversion_failing' and status = 'open';

notify pgrst, 'reload schema';
