-- 0265 — Supervisão de um agente por outro (revisão administrativa pós-execução).
--
-- POR QUE: criar um segundo agente e ligar capacidades nele não faz ninguém
-- revisar o trabalho do primeiro. O papel "Organiza o sistema" (operator_turn)
-- roda depois das conversas do PRÓPRIO agente; roteadores distribuem atendimento
-- por intenção. Nenhum dos dois é auditoria posterior de OUTRO agente. Esta
-- migration dá ao sistema o que faltava para esse acionamento existir, ser
-- idempotente e deixar rastro:
--
--   1. `ai_supervision_bindings` — QUEM supervisiona QUEM, em QUAL funil. É dado
--      de configuração por organização, nunca id cravado no código. Nasce
--      DESLIGADO (`enabled=false`) e em modo `recomendar`: aplicar a migration
--      não liga supervisão para ninguém nem autoriza mexer em card nenhum.
--   2. `ai_supervision_reviews` — o registro DURÁVEL de cada revisão, com a chave
--      de idempotência `organization_id:conversation_id:event_id:supervisor_agent_id`.
--      Reentrega do mesmo evento encontra a linha e devolve o resultado anterior.
--   3. `ai_supervision_actions` — cada ação pretendida, com chave própria. Uma
--      retentativa nunca repete ação que já está `executada`.
--   4. `crm_stages.blocks_followups` — etapa que INVALIDA sequências de
--      follow-up (ex.: "Comprovante em conferência"). Default false.
--   5. `job_queue.kind` ganha `supervisor_review` (tem contato: serializa na
--      mesma lane do contato, então duas revisões da mesma conversa não correm
--      juntas).
--   6. `agent_inbox_items.kind` ganha `supervision_review` — pendência que a
--      revisão abriu para a equipe.
--
-- Nenhum dado existente muda. Nenhuma linha existente usa os valores novos, então
-- recriar os CHECKs não reprova o que já está gravado.

-- ---- 1. vínculo supervisor → supervisionado ---------------------------------
create table if not exists public.ai_supervision_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supervisor_agent_id uuid not null references public.ai_agents(id) on delete cascade,
  supervised_agent_id uuid not null references public.ai_agents(id) on delete cascade,
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  enabled boolean not null default false,
  -- Também revisar ações HUMANAS concluídas na conversa (mensagem enviada por
  -- pessoa da equipe, card movido por pessoa).
  review_human_actions boolean not null default true,
  -- `recomendar`: nada é executado, tudo vira RECOM/BLOQ.
  -- `executar`: só as transições listadas em `allowed_stage_moves` executam.
  mode text not null default 'recomendar' check (mode in ('recomendar', 'executar')),
  -- [{"to_stage_id": uuid, "from_stage_ids": [uuid, ...]}]. Lista vazia = nenhuma
  -- movimentação executável, mesmo em modo `executar`.
  allowed_stage_moves jsonb not null default '[]'::jsonb,
  -- Identificador da política vigente — gravado em cada revisão.
  policy_version text not null default 'v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_supervision_bindings_not_self check (supervisor_agent_id <> supervised_agent_id),
  constraint ai_supervision_bindings_moves_is_array check (jsonb_typeof(allowed_stage_moves) = 'array'),
  unique (organization_id, supervisor_agent_id, supervised_agent_id, pipeline_id)
);

create index if not exists ai_supervision_bindings_supervised_idx
  on public.ai_supervision_bindings (organization_id, supervised_agent_id)
  where enabled;

comment on table public.ai_supervision_bindings is
  'Quem supervisiona quem, em qual funil. Nasce desligado e em modo recomendar. Escrita só server-side.';

-- ---- 2. revisão ---------------------------------------------------------------
create table if not exists public.ai_supervision_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  binding_id uuid not null references public.ai_supervision_bindings(id) on delete cascade,
  idempotency_key text not null,
  event_id uuid not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  lead_id uuid references public.crm_leads(id) on delete set null,
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  actor_type text not null check (actor_type in ('ai_agent', 'user')),
  actor_id uuid not null,
  occurred_at timestamptz not null,
  conversation_revision bigint,
  origin text not null check (origin in ('ai_run_completed', 'human_message_sent', 'human_stage_changed')),
  trace_id text not null,
  supervisor_agent_id uuid not null references public.ai_agents(id) on delete cascade,
  status text not null default 'pendente'
    check (status in ('pendente', 'em_execucao', 'concluida', 'bloqueada', 'falhou')),
  outcome_code text check (outcome_code in ('EXE', 'RECOM', 'BLOQ')),
  policy_version text not null,
  prompt_version text,
  -- Estado lido, só por referência (ids, etapas, flags). Nunca texto clínico,
  -- nunca corpo de mensagem, nunca imagem de comprovante.
  state_read jsonb not null default '{}'::jsonb,
  -- A proposta do supervisor, gravada na PRIMEIRA leitura válida. Retentativa
  -- reaproveita esta proposta em vez de chamar o modelo de novo: uma segunda
  -- resposta diferente geraria ações diferentes, e a ação já executada da
  -- primeira tentativa não teria como ser reconhecida.
  proposal jsonb,
  stage_before_id uuid,
  stage_recommended_id uuid,
  exit_reason text,
  human_validator_user_id uuid,
  job_id uuid,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index if not exists ai_supervision_reviews_conversation_idx
  on public.ai_supervision_reviews (organization_id, conversation_id, created_at desc);

comment on table public.ai_supervision_reviews is
  'Revisão individual de uma execução (IA ou humana) por um agente supervisor. Chave de idempotência org:conversa:evento:supervisor. EXE só com retorno de ferramenta; RECOM/BLOQ sempre com motivo.';

-- ---- 3. ações -----------------------------------------------------------------
create table if not exists public.ai_supervision_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  review_id uuid not null references public.ai_supervision_reviews(id) on delete cascade,
  action_key text not null,
  kind text not null check (kind in ('mover_etapa', 'registrar_pendencia')),
  -- NULL enquanto a ação está pendente: o código só existe quando há desfecho.
  code text check (code in ('EXE', 'RECOM', 'BLOQ')),
  status text not null default 'pendente'
    check (status in ('pendente', 'executada', 'recomendada', 'bloqueada', 'falhou')),
  expected_stage_id uuid,
  target_stage_id uuid,
  -- ids de mensagens/atividades que sustentam a ação. Só ids.
  evidence_ids jsonb not null default '[]'::jsonb,
  reason text not null,
  next_owner text,
  tool_result_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_supervision_actions_code_only_when_final check ((status = 'pendente') = (code is null)),
  -- EXE só existe com a ferramenta confirmando: status executada E referência do resultado.
  constraint ai_supervision_actions_exe_has_result check (code is distinct from 'EXE' or (status = 'executada' and tool_result_ref is not null)),
  unique (organization_id, action_key)
);

create index if not exists ai_supervision_actions_review_idx
  on public.ai_supervision_actions (organization_id, review_id);

-- ---- RLS: membros LEEM; só o servidor escreve --------------------------------
alter table public.ai_supervision_bindings enable row level security;
alter table public.ai_supervision_reviews enable row level security;
alter table public.ai_supervision_actions enable row level security;

drop policy if exists tenant_isolation_ai_supervision_bindings_select on public.ai_supervision_bindings;
create policy tenant_isolation_ai_supervision_bindings_select on public.ai_supervision_bindings
  for select using (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_ai_supervision_reviews_select on public.ai_supervision_reviews;
create policy tenant_isolation_ai_supervision_reviews_select on public.ai_supervision_reviews
  for select using (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_ai_supervision_actions_select on public.ai_supervision_actions;
create policy tenant_isolation_ai_supervision_actions_select on public.ai_supervision_actions
  for select using (organization_id in (select fn_user_org_ids()));

-- O registro de auditoria não se reescreve pela REST (lição da 0258: o default
-- ACL do Supabase concede tudo; só `revoke` explícito protege).
revoke insert, update, delete, truncate on public.ai_supervision_bindings from public, anon, authenticated;
revoke insert, update, delete, truncate on public.ai_supervision_reviews from public, anon, authenticated;
revoke insert, update, delete, truncate on public.ai_supervision_actions from public, anon, authenticated;
grant select on public.ai_supervision_bindings, public.ai_supervision_reviews, public.ai_supervision_actions to authenticated;
grant select, insert, update on public.ai_supervision_bindings, public.ai_supervision_reviews, public.ai_supervision_actions to service_role;

drop trigger if exists trg_ai_supervision_bindings_updated_at on public.ai_supervision_bindings;
create trigger trg_ai_supervision_bindings_updated_at
  before update on public.ai_supervision_bindings
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_ai_supervision_reviews_updated_at on public.ai_supervision_reviews;
create trigger trg_ai_supervision_reviews_updated_at
  before update on public.ai_supervision_reviews
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_ai_supervision_actions_updated_at on public.ai_supervision_actions;
create trigger trg_ai_supervision_actions_updated_at
  before update on public.ai_supervision_actions
  for each row execute function public.fn_set_updated_at();

-- ---- 4. etapa que invalida follow-up ------------------------------------------
alter table public.crm_stages
  add column if not exists blocks_followups boolean not null default false;

comment on column public.crm_stages.blocks_followups is
  'Lead nesta etapa não recebe follow-up automático: a entrada invalida sequências vivas e o executor reconfere antes de cada envio. Ex.: comprovante em conferência.';

-- ---- 5. job_queue: supervisor_review ------------------------------------------
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery','approved_reply','supervisor_review'));
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply','supervisor_review')) = (contact_id is not null));

-- ---- 6. agent_inbox_items: supervision_review ---------------------------------
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
    'other'
  ));

notify pgrst, 'reload schema';
