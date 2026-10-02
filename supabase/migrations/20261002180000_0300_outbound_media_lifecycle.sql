-- Outbound uploads reserve quota before Storage and expire unless consumed.
create table if not exists public.outbound_media_uploads (
  object_path text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  state text not null default 'pending' check (state in ('pending','attached','deleting','deleted')),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
alter table public.outbound_media_uploads enable row level security;
revoke all on public.outbound_media_uploads from public, anon, authenticated;
grant all on public.outbound_media_uploads to service_role;
create index if not exists outbound_media_pending_org on public.outbound_media_uploads (organization_id) where state in ('pending','deleting');
create index if not exists outbound_media_expiry on public.outbound_media_uploads (expires_at) where state in ('pending','deleting');

create or replace function public.fn_reserve_outbound_media(p_org uuid, p_conversation uuid, p_path text, p_bytes bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_bytes <= 0 or p_bytes > 52428800 or p_path not like p_org::text || '/' || p_conversation::text || '/out-%' then
    raise exception 'invalid upload';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation and organization_id = p_org) then
    raise exception 'invalid conversation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('outbound-media:' || p_org::text, 0));
  if (select count(*) >= 20 or coalesce(sum(size_bytes), 0) + p_bytes > 104857600
      from public.outbound_media_uploads where organization_id = p_org and state in ('pending','deleting')) then
    return false;
  end if;
  insert into public.outbound_media_uploads(object_path, organization_id, conversation_id, size_bytes)
    values (p_path, p_org, p_conversation, p_bytes);
  return true;
end;
$$;
revoke all on function public.fn_reserve_outbound_media(uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.fn_reserve_outbound_media(uuid,uuid,text,bigint) to service_role;

create or replace function public.fn_attach_outbound_media()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare upload public.outbound_media_uploads;
begin
  if new.media_storage_path is null then return new; end if;
  select * into upload from public.outbound_media_uploads where object_path = new.media_storage_path for update;
  if not found then return new; end if; -- Legacy / inbound media retains its existing ownership guards.
  if upload.organization_id <> new.organization_id or upload.conversation_id is distinct from new.conversation_id
     or upload.state in ('deleting','deleted') or (upload.state = 'pending' and upload.expires_at <= now()) then
    raise exception 'media upload expired or outside conversation' using errcode = '23514';
  end if;
  update public.outbound_media_uploads set state = 'attached' where object_path = upload.object_path;
  return new;
end;
$$;
revoke all on function public.fn_attach_outbound_media() from public, anon, authenticated;
drop trigger if exists trg_attach_outbound_media on public.messages;
create trigger trg_attach_outbound_media before insert or update of media_storage_path on public.messages
for each row execute function public.fn_attach_outbound_media();

create or replace function public.fn_claim_expired_outbound_media(p_limit integer default 50)
returns setof public.outbound_media_uploads language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select object_path from public.outbound_media_uploads
    where state in ('pending','deleting') and expires_at <= now()
    order by expires_at limit greatest(1, least(p_limit, 200)) for update skip locked
  )
  update public.outbound_media_uploads u set state = 'deleting', expires_at = now() + interval '5 minutes'
  from candidates c where u.object_path = c.object_path returning u.*;
$$;
revoke all on function public.fn_claim_expired_outbound_media(integer) from public, anon, authenticated;
grant execute on function public.fn_claim_expired_outbound_media(integer) to service_role;
