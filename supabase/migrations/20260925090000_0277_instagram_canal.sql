-- Canal Instagram (spec docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md).
alter table public.channel_sessions
  add column if not exists ig_account_id text,
  add column if not exists ig_username text,
  add column if not exists ig_token_encrypted bytea,
  add column if not exists ig_token_expires_at timestamptz;

alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check
  check (provider = any (array['waha','meta_cloud','zernio','wacalls','meta_instagram']));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
  (provider = 'waha'           and waha_session_name    is not null) or
  (provider = 'meta_cloud'     and meta_phone_number_id is not null) or
  (provider = 'zernio'         and zernio_account_id    is not null) or
  (provider = 'wacalls'        and wacalls_session_id   is not null) or
  (provider = 'meta_instagram' and ig_account_id        is not null)
);

-- Uma conta do Instagram ativa em UMA organização da instalação: o webhook é do app
-- e roteia por conta; duas orgs com a mesma conta seria entrega ambígua.
create unique index if not exists uniq_channel_sessions_ig_account_ativa
  on public.channel_sessions (ig_account_id)
  where ig_account_id is not null and archived_at is null;

alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel = any (array['whatsapp','instagram']));

alter table public.platform_meta_app
  add column if not exists ig_app_id text,
  add column if not exists ig_app_secret_encrypted bytea;

create table if not exists public.contact_channel_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null check (channel = any (array['instagram'])),
  external_id text not null,
  handle text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, channel, external_id)
);
create index if not exists idx_contact_channel_identities_contact
  on public.contact_channel_identities (organization_id, contact_id);

alter table public.contact_channel_identities enable row level security;
drop policy if exists tenant_isolation_contact_channel_identities_all on public.contact_channel_identities;
-- Escrita direta pelo PostgREST não é o caminho normal (quem grava é o
-- webhook via fn_upsert_contato_por_identidade, service_role), mas a RLS
-- protege o acesso direto de qualquer membro logado; piso 'agent' segue o
-- mesmo padrão de channel_sessions/voice_calls (doutrina RBAC, migration 0150).
create policy tenant_isolation_contact_channel_identities_all on public.contact_channel_identities
  for all using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

drop trigger if exists trg_contact_channel_identities_updated_at on public.contact_channel_identities;
create trigger trg_contact_channel_identities_updated_at
  before update on public.contact_channel_identities
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_upsert_contato_por_identidade(
  p_org uuid, p_canal text, p_external_id text, p_handle text, p_nome text, p_avatar text
) returns table(contact_id uuid, criado boolean)
language plpgsql security definer set search_path = public as $$
declare v_contato uuid;
begin
  select i.contact_id into v_contato from public.contact_channel_identities i
   where i.organization_id = p_org and i.channel = p_canal and i.external_id = p_external_id;
  if v_contato is not null then
    update public.contact_channel_identities set
      handle = coalesce(nullif(p_handle, ''), handle),
      display_name = coalesce(nullif(p_nome, ''), display_name),
      avatar_url = coalesce(nullif(p_avatar, ''), avatar_url),
      updated_at = now()
    where organization_id = p_org and channel = p_canal and external_id = p_external_id;
    return query select v_contato, false;
    return;
  end if;
  insert into public.contacts (organization_id, source, consent, tags, source_metadata, display_name)
  values (p_org, p_canal, '{}'::jsonb, '{}'::text[],
          jsonb_build_object('handle', nullif(p_handle, '')),
          coalesce(nullif(p_nome, ''), nullif(p_handle, '')))
  returning id into v_contato;
  insert into public.contact_channel_identities (organization_id, contact_id, channel, external_id, handle, display_name, avatar_url)
  values (p_org, v_contato, p_canal, p_external_id, nullif(p_handle, ''), nullif(p_nome, ''), nullif(p_avatar, ''))
  on conflict (organization_id, channel, external_id) do nothing;
  if not found then
    -- corrida: outra entrega criou a identidade entre o select e o insert
    delete from public.contacts where id = v_contato;
    select i.contact_id into v_contato from public.contact_channel_identities i
     where i.organization_id = p_org and i.channel = p_canal and i.external_id = p_external_id;
    return query select v_contato, false;
    return;
  end if;
  return query select v_contato, true;
end; $$;

create or replace function public.fn_upsert_conversa_de_canal(
  p_org uuid, p_contact uuid, p_session uuid, p_canal text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, metadata)
  values (p_org, p_contact, p_session, p_canal, 'open', false, 0, '{}'::jsonb)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

revoke execute on function public.fn_upsert_contato_por_identidade(uuid, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.fn_upsert_contato_por_identidade(uuid, text, text, text, text, text) to service_role;
revoke execute on function public.fn_upsert_conversa_de_canal(uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.fn_upsert_conversa_de_canal(uuid, uuid, uuid, text) to service_role;

-- fn_lgpd_cascade_redact_contact ganha o passo 7c: handle/nome/avatar do
-- Instagram são dado de pessoa (tests/invariants/lgpd-cascata-alcanca-quem-
-- guarda-pessoa.test.ts casa FK para contacts + coluna PII). Corpo idêntico ao
-- já publicado, só com o passo novo entre voice_calls (7b) e o audit row (8).
create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. enqueue media for async deletion
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  -- 7c. contact_channel_identities — handle/nome/avatar do Instagram (migration 0277).
  --     external_id e channel FICAM: são o apontador técnico (o IGSID da Meta),
  --     não conteúdo da pessoa, e apagá-los faria o próximo evento do MESMO
  --     IGSID criar um contato NOVO em vez de reconhecer o já anonimizado.
  update contact_channel_identities set
    handle = null,
    display_name = null,
    avatar_url = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_channel_identities', v_count);

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;
revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;
