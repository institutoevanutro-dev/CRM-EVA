-- Comentários do Instagram: tabela de comentários capturados e tabela de
-- regras (palavra-gatilho → resposta pública + Direct) por mídia.
-- Task 1 de 9 da feature "comentários no CRM" — só o banco; as tasks
-- seguintes leem/escrevem estas colunas pelo nome.
create table if not exists public.instagram_comments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  external_id text not null,
  media_id text not null,
  texto text,
  autor_igsid text not null,
  autor_handle text,
  contact_id uuid references public.contacts(id) on delete set null,
  comentado_em timestamptz not null,
  situacao text not null default 'novo'
    check (situacao in ('novo','respondido_pela_regra','respondido_pela_ia','esperando_voce','ignorado')),
  regra_id uuid,
  resposta_publica_id text,
  private_reply_message_id text,
  sugestao_de_resposta text,
  motivo_do_toque text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists instagram_comments_externo
  on public.instagram_comments(organization_id, external_id);
create index if not exists instagram_comments_fila
  on public.instagram_comments(organization_id, situacao, comentado_em desc);

create table if not exists public.instagram_comment_rules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  media_id text not null,
  palavra text not null,
  texto_do_direct text not null,
  frase_publica text not null,
  ativa boolean not null default true,
  criada_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists instagram_comment_rules_video
  on public.instagram_comment_rules(organization_id, media_id) where ativa;

alter table public.instagram_comments enable row level security;
alter table public.instagram_comment_rules enable row level security;

-- Divergência do briefing (documentada no relatório da task): o briefing dava
-- uma policy `for all` só de tenancy. `tests/invariants/rbac-config-ia-canais.test.ts`
-- ("nenhuma tabela NOVA entra com policy ALL só-tenancy") reprova qualquer
-- tabela nova sem `fn_role_at_least` na escrita — doutrina da migration 0150,
-- posterior ao que o briefing podia saber. Leitura fica aberta a todo membro
-- do tenant (a fila de comentários e as regras são visíveis para todo mundo);
-- escrita exige papel, no mesmo formato de `channel_sessions`/`ai_agents`
-- (SELECT solto + ALL com `fn_role_at_least`).
drop policy if exists tenant_isolation_instagram_comments_all on public.instagram_comments;

drop policy if exists instagram_comments_select on public.instagram_comments;
create policy instagram_comments_select on public.instagram_comments
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists instagram_comments_write on public.instagram_comments;
create policy instagram_comments_write on public.instagram_comments
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists tenant_isolation_instagram_comment_rules_all on public.instagram_comment_rules;

drop policy if exists instagram_comment_rules_select on public.instagram_comment_rules;
create policy instagram_comment_rules_select on public.instagram_comment_rules
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists instagram_comment_rules_write on public.instagram_comment_rules;
create policy instagram_comment_rules_write on public.instagram_comment_rules
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );
