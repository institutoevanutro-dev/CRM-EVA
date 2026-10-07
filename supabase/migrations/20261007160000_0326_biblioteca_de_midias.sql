-- supabase/migrations/20261007160000_0326_biblioteca_de_midias.sql
-- Biblioteca de mídias (Fase 2, fatia 1): acervo de imagem e vídeo da organização,
-- com termo de uso de imagem. Arquivos no bucket PRÓPRIO `media-library`, separado
-- do `whatsapp-media`: a anonimização LGPD recolhe só messages.media_storage_path,
-- então o acervo nunca é apagado pela anonimização de um contato.

create table if not exists public.media_library_items (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  when_to_use text not null default '',
  tags text[] not null default '{}',
  variants jsonb not null default '[]'::jsonb,
  contains_person boolean not null default true,
  consent_subject text,
  consent_scope text,
  consent_signed_at date,
  consent_expires_at date,
  consent_revoked_at timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_library_items_title_check check (btrim(title) <> ''),
  constraint media_library_items_variants_array check (jsonb_typeof(variants) = 'array' and jsonb_array_length(variants) <= 2)
);

create index if not exists media_library_items_org_idx on public.media_library_items (organization_id);
create index if not exists media_library_items_tags_gin on public.media_library_items using gin (tags);

drop trigger if exists trg_media_library_items_updated_at on public.media_library_items;
create trigger trg_media_library_items_updated_at
  before update on public.media_library_items
  for each row execute function public.fn_set_updated_at();

alter table public.media_library_items enable row level security;

drop policy if exists tenant_isolation_media_library_items_all on public.media_library_items;
drop policy if exists tenant_isolation_media_library_items_select on public.media_library_items;
create policy tenant_isolation_media_library_items_select on public.media_library_items
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_media_library_items_write on public.media_library_items;
create policy tenant_isolation_media_library_items_write on public.media_library_items
  for all using (
    organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')
  );
drop policy if exists security_role_insert on public.media_library_items;
create policy security_role_insert on public.media_library_items as restrictive for insert to authenticated
  with check (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists security_role_update on public.media_library_items;
create policy security_role_update on public.media_library_items as restrictive for update to authenticated
  using (public.fn_role_at_least(organization_id, 'manager'))
  with check (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists security_role_delete on public.media_library_items;
create policy security_role_delete on public.media_library_items as restrictive for delete to authenticated
  using (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists mfa_provada on public.media_library_items;
create policy mfa_provada on public.media_library_items as restrictive for all to authenticated
  using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()));

revoke all on public.media_library_items from public, anon;
revoke truncate, references, trigger on public.media_library_items from authenticated;
grant select, insert, update, delete on public.media_library_items to authenticated;
grant all on public.media_library_items to service_role;

-- Bucket privado; só o service_role lê e grava (quem autoriza é o requireRole da rota).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media-library', 'media-library', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/3gpp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
