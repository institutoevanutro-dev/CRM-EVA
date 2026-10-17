-- Migration 0380 : CADA AGENTE DECLARA EM QUAIS NÚMEROS ATENDE.
--
-- Portado e ADAPTADO do projeto original (DeskcommCRM, PR #2854 de
-- @webtecnica; lá é a migration 0665, `ai_agent_version_channels`).
--
-- O QUE MUDA DE SENTIDO EM RELAÇÃO AO ORIGINAL: lá a tabela liga a VERSÃO a
-- números ADICIONAIS ao principal, para um mesmo agente atender N números.
-- Aqui a pergunta da clínica é a contrária — "em quais números este agente
-- PODE falar?" —, porque neste fork o agente já atende onde o roteador do
-- número o chama (`ai_router_members`), qualquer que seja o número da versão
-- dele. A tabela é uma LISTA DE PERMISSÃO por AGENTE:
--
--   - nenhuma linha para o agente = ele atende em TODOS os números, como hoje.
--     É o padrão, e é por isso que nenhum agente existente muda de
--     comportamento com esta migration (nenhum dado é escrito);
--   - uma ou mais linhas = ele só atende nos números listados. Nos outros, o
--     roteador não o oferece, o número não o escolhe, e o portão de custo
--     (`drain.ts`) não abre turno por causa dele.
--
-- Por AGENTE e não por versão: é configuração de operação, como `priority` e
-- `paused_at`, que mudam sem publicar versão nova. Mudar é uma mutação com
-- trilha (`ai_agent.numbers_changed`, rota `/api/v1/ai/agents/:id/numeros`).
--
-- FKs COMPOSTAS por organização: o agente e o número têm de ser da MESMA
-- organização da linha. Apagar o agente leva as linhas junto; apagar um número
-- citado é RECUSADO (como `ai_agent_versions_channel_session_id_fkey`): se a
-- linha sumisse em cascata e fosse a última, o agente passaria a atender em
-- TODOS os números sem ninguém pedir.
--
-- A regra mora numa função só, `fn_agente_atende_no_numero(org, agente,
-- número)`, `security invoker` e `stable`, lida pelo motor (agent-config,
-- router-config, resolve-turn-agent, drain). As duas origens de EXECUTE
-- revogadas (CLAUDE.md, item 9); só o service_role executa.
--
-- RLS: leitura por organização, escrita só de admin (molde de
-- `ai_agent_versions`, migration 0150). `authenticated` só tem SELECT: a
-- escrita passa pela rota, que audita.
--
-- Idempotente. No baseline, bloco antes da VARREDURA anon (cria função).
-- Prova: tests/invariants/agente-declara-em-quais-numeros-atende.test.ts e
-- tests/invariants/rls-isolation.test.ts.

create table if not exists public.ai_agent_channel_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null,
  channel_session_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint ai_agent_channel_sessions_unico unique (agent_id, channel_session_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_agent_channel_sessions_agent_org_fk') then
    alter table public.ai_agent_channel_sessions
      add constraint ai_agent_channel_sessions_agent_org_fk
      foreign key (organization_id, agent_id)
      references public.ai_agents (organization_id, id)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_agent_channel_sessions_channel_org_fk') then
    alter table public.ai_agent_channel_sessions
      add constraint ai_agent_channel_sessions_channel_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete restrict;
  end if;
end $$;

comment on table public.ai_agent_channel_sessions is
  'Em quais números (channel_sessions) cada agente PODE atender. Nenhuma linha para o agente = todos os números (o padrão). Lida por fn_agente_atende_no_numero.';

create index if not exists idx_ai_agent_channel_sessions_agente
  on public.ai_agent_channel_sessions (organization_id, agent_id);

alter table public.ai_agent_channel_sessions enable row level security;

drop policy if exists tenant_isolation_ai_agent_channel_sessions_select on public.ai_agent_channel_sessions;
create policy tenant_isolation_ai_agent_channel_sessions_select on public.ai_agent_channel_sessions
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_agent_channel_sessions_write on public.ai_agent_channel_sessions;
create policy tenant_isolation_ai_agent_channel_sessions_write on public.ai_agent_channel_sessions
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

drop policy if exists mfa_provada on public.ai_agent_channel_sessions;
create policy mfa_provada on public.ai_agent_channel_sessions as restrictive for all to authenticated
  using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()));

revoke all on public.ai_agent_channel_sessions from anon, authenticated;
grant select on public.ai_agent_channel_sessions to authenticated;
grant all on public.ai_agent_channel_sessions to service_role;

create or replace function public.fn_agente_atende_no_numero(p_org uuid, p_agent uuid, p_session uuid)
returns boolean
language sql stable
set search_path = public
as $$
  select not exists (
           select 1 from public.ai_agent_channel_sessions n
            where n.organization_id = p_org and n.agent_id = p_agent)
      or exists (
           select 1 from public.ai_agent_channel_sessions n
            where n.organization_id = p_org and n.agent_id = p_agent and n.channel_session_id = p_session);
$$;

revoke execute on function public.fn_agente_atende_no_numero(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_agente_atende_no_numero(uuid, uuid, uuid) to service_role;
