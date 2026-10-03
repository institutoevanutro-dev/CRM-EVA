-- 0306 — Respostas prontas antes da IA (spec EvaLink 2026-10-03).
--
-- Quatro tabelas por organização:
--   respostas_prontas            o item: a resposta, ativo, revisado_em
--   respostas_prontas_perguntas  as formas de perguntar, cada uma com o embedding
--                                (openai/text-embedding-3-small, o mesmo da base de
--                                conhecimento) calculado no cadastro; NULL = ainda
--                                não reconhecida (sem chave ou falha), a tela avisa
--   respostas_prontas_config     liga/desliga e o limite; SEM LINHA = DESLIGADO
--   respostas_prontas_usos       uma linha por resposta pronta enviada — a métrica.
--                                Nunca `llm_calls`: ali é chamada de modelo.
--
-- Escrita das três primeiras: manager+. A policy de tenancy é partida como na
-- 0181 (ai_faq_items): `_select` só-tenancy e `_write` (for all) com tenancy E
-- `fn_role_at_least(...,'manager')` — policy ALL só-tenancy é dívida de RBAC que
-- `tests/invariants/rbac-config-ia-canais.test.ts` reprova. As restritivas
-- `security_role_*` (desenho da 0299) ficam como segunda trava.
-- Usos: só o serviço (o worker grava com o pool do motor).
-- `mfa_provada` explícita: o bloco da 0301 varre as tabelas que JÁ existiam, e
-- num install fresco estas nascem depois dele.
-- Uma função nova, `fn_respostas_prontas_metricas` (security invoker), com
-- `revoke ... from public, anon` explícito no fim — as duas origens de EXECUTE.

create table if not exists public.respostas_prontas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  titulo text not null,
  resposta text not null,
  ativo boolean not null default true,
  revisado_em timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint respostas_prontas_org_id_uniq unique (organization_id, id)
);

create table if not exists public.respostas_prontas_perguntas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resposta_pronta_id uuid not null,
  texto text not null,
  embedding public.vector(1536),
  modelo_embedding text,
  created_at timestamptz not null default now(),
  constraint respostas_prontas_perguntas_texto_uniq unique (organization_id, resposta_pronta_id, texto),
  constraint respostas_prontas_perguntas_item_fk foreign key (organization_id, resposta_pronta_id)
    references public.respostas_prontas (organization_id, id) on delete cascade
);
create index if not exists respostas_prontas_perguntas_item_idx
  on public.respostas_prontas_perguntas (organization_id, resposta_pronta_id);

create table if not exists public.respostas_prontas_config (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ligado boolean not null default false,
  limite_similaridade real not null default 0.82,
  updated_at timestamptz not null default now(),
  constraint respostas_prontas_config_limite check (limite_similaridade between 0.78 and 0.95)
);

create table if not exists public.respostas_prontas_usos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resposta_pronta_id uuid not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- Chave de deduplicação do replay, não ponteiro de vida: a poda da fila apaga
  -- jobs velhos, e a métrica não pode sumir junto.
  job_id uuid references public.job_queue(id) on delete set null,
  similaridade real not null,
  created_at timestamptz not null default now(),
  constraint respostas_prontas_usos_um_por_job unique (organization_id, job_id),
  constraint respostas_prontas_usos_item_fk foreign key (organization_id, resposta_pronta_id)
    references public.respostas_prontas (organization_id, id) on delete cascade
);
create index if not exists respostas_prontas_usos_org_tempo_idx
  on public.respostas_prontas_usos (organization_id, created_at);
-- A FK `job_id -> job_queue on delete set null` precisa de índice no lado
-- filho: sem ele, cada job podado pela fila varre a tabela inteira de usos.
create index if not exists respostas_prontas_usos_job_idx
  on public.respostas_prontas_usos (job_id);

alter table public.respostas_prontas enable row level security;
alter table public.respostas_prontas_perguntas enable row level security;
alter table public.respostas_prontas_config enable row level security;
alter table public.respostas_prontas_usos enable row level security;

do $rp$
declare t text;
begin
  foreach t in array array['respostas_prontas','respostas_prontas_perguntas','respostas_prontas_config'] loop
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_' || t || '_all', t);
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_' || t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (organization_id in (select public.fn_user_org_ids()))',
      'tenant_isolation_' || t || '_select', t);
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_' || t || '_write', t);
    execute format(
      'create policy %I on public.%I for all using ('
      'organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, %L)'
      ') with check ('
      'organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, %L))',
      'tenant_isolation_' || t || '_write', t, 'manager', 'manager');
    execute format('drop policy if exists security_role_insert on public.%I', t);
    execute format('drop policy if exists security_role_update on public.%I', t);
    execute format('drop policy if exists security_role_delete on public.%I', t);
    execute format('create policy security_role_insert on public.%I as restrictive for insert to authenticated '
                   'with check (public.fn_role_at_least(organization_id, %L))', t, 'manager');
    execute format('create policy security_role_update on public.%I as restrictive for update to authenticated '
                   'using (public.fn_role_at_least(organization_id, %L)) with check (public.fn_role_at_least(organization_id, %L))',
                   t, 'manager', 'manager');
    execute format('create policy security_role_delete on public.%I as restrictive for delete to authenticated '
                   'using (public.fn_role_at_least(organization_id, %L))', t, 'manager');
    execute format('revoke all on public.%I from public, anon', t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;

  foreach t in array array['respostas_prontas','respostas_prontas_perguntas','respostas_prontas_config','respostas_prontas_usos'] loop
    execute format('drop policy if exists mfa_provada on public.%I', t);
    execute format(
      'create policy mfa_provada on public.%I as restrictive for all to authenticated '
      'using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()))',
      t);
  end loop;
end $rp$;

drop policy if exists tenant_isolation_respostas_prontas_usos_select on public.respostas_prontas_usos;
create policy tenant_isolation_respostas_prontas_usos_select on public.respostas_prontas_usos
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

revoke all on public.respostas_prontas_usos from public, anon, authenticated;
grant select on public.respostas_prontas_usos to authenticated;
grant all on public.respostas_prontas_usos to service_role;

-- Medição por clínica e período, agregada NO BANCO: o PostgREST corta em
-- max_rows=1000, e contar linhas no cliente truncaria em silêncio a clínica
-- movimentada. SECURITY INVOKER: a RLS do chamador vale (manager da org);
-- organization_id filtrado à mão mesmo assim.
create or replace function public.fn_respostas_prontas_metricas(
  p_org uuid, p_desde timestamptz, p_ate timestamptz default now()
) returns table (
  resolvidas bigint,
  respondidas_pela_ia bigint,
  custo_total_cents numeric,
  custo_incompleto boolean
)
language sql stable security invoker
set search_path = public, pg_temp
as $fn$
  select
    (select count(*) from public.respostas_prontas_usos u
      where u.organization_id = p_org and u.created_at >= p_desde and u.created_at < p_ate),
    count(distinct c.job_id),
    coalesce(sum(c.cost_cents), 0),
    coalesce(bool_or(c.cost_cents is null), false)
  from public.llm_calls c
  where c.organization_id = p_org and c.purpose = 'agent_turn' and c.job_id is not null
    and c.created_at >= p_desde and c.created_at < p_ate;
$fn$;

revoke execute on function public.fn_respostas_prontas_metricas(uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function public.fn_respostas_prontas_metricas(uuid, timestamptz, timestamptz) to authenticated, service_role;
