-- Prestador e um papel humano abaixo de colaborador. O escopo proprio sera
-- aplicado pelas policies da migration seguinte; aqui nasce o vocabulario e
-- a funcao unica que reconhece o vinculo com um paciente.

alter table public.user_organizations drop constraint if exists user_organizations_role_check;
alter table public.user_organizations add constraint user_organizations_role_check
  check (role in ('viewer','provider','agent','manager','admin'));

alter table public.team_invites drop constraint if exists team_invites_role_check;
alter table public.team_invites add constraint team_invites_role_check
  check (role in ('viewer','provider','agent','manager','admin'));

create or replace function public.fn_role_at_least(p_org uuid, p_min text)
returns boolean language sql stable security definer set search_path = public as $$
  with levels(role, lvl) as (
    values ('viewer',1),('provider',2),('agent',3),('manager',4),('admin',5)
  )
  select coalesce(
    (select user_lvl.lvl >= min_lvl.lvl
       from levels user_lvl
       join levels min_lvl on min_lvl.role = p_min
      where user_lvl.role = public.fn_user_role_in_org(p_org)),
    false
  );
$$;

create or replace function public.fn_provider_can_access_contact(
  p_org uuid, p_contact uuid, p_user uuid default auth.uid()
) returns boolean
language sql stable security definer set search_path = '' as $$
  select
    p_user is not null
    and (auth.uid() is null or auth.uid() = p_user)
    and exists (
      select 1 from public.user_organizations u
       where u.organization_id = p_org
         and u.user_id = p_user
         and u.role = 'provider'
         and u.revoked_at is null
    )
    and (
      exists (
        select 1 from public.calendar_appointments a
         where a.organization_id = p_org
           and a.contact_id = p_contact
           and a.owner_user_id = p_user
      )
      or exists (
        select 1 from public.crm_leads l
         where l.organization_id = p_org
           and l.contact_id = p_contact
           and l.owner_user_id = p_user
      )
      or exists (
        select 1 from public.conversations c
         where c.organization_id = p_org
           and c.contact_id = p_contact
           and c.assigned_to_user_id = p_user
      )
    );
$$;
revoke all on function public.fn_provider_can_access_contact(uuid,uuid,uuid) from public, anon;
grant execute on function public.fn_provider_can_access_contact(uuid,uuid,uuid) to authenticated, service_role;

create or replace function public.fn_accept_team_invite(
  p_user uuid, p_org uuid, p_role text, p_invited_by uuid,
  p_issued_at timestamptz, p_invited_at timestamptz,
  p_interface_settings jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.user_organizations%rowtype;
begin
  if p_role not in ('viewer','provider','agent','manager','admin') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_org::text, 0));
  if not exists(select 1 from public.organizations where id = p_org and status = 'active') then
    raise exception 'organization_unavailable' using errcode = '42501';
  end if;
  select * into m from public.user_organizations
    where organization_id = p_org and user_id = p_user for update;
  if found and m.revoked_at is null and m.accepted_at is not null then
    return jsonb_build_object('id', m.id, 'changed', false);
  end if;
  if found and m.revoked_at is not null and (p_issued_at is null or p_issued_at <= m.revoked_at) then
    raise exception 'invite_revoked' using errcode = '42501';
  end if;
  if m.id is not null then
    update public.user_organizations set role = p_role, revoked_at = null,
      interface_settings = p_interface_settings,
      invited_by = coalesce(p_invited_by, invited_by), invited_at = p_invited_at,
      accepted_at = now(), updated_at = now()
      where organization_id = p_org and id = m.id returning * into m;
  else
    insert into public.user_organizations
      (organization_id,user_id,role,invited_by,invited_at,accepted_at,interface_settings)
    values (p_org,p_user,p_role,p_invited_by,p_invited_at,now(),p_interface_settings)
    returning * into m;
  end if;
  if p_role = 'admin' then
    delete from public.attendant_availability av
     where av.organization_id = p_org and av.user_id <> p_user
       and exists (select 1 from public.user_organizations uo
                    where uo.organization_id = p_org and uo.user_id = av.user_id
                      and uo.provisional_until_handover);
    delete from public.user_organizations uo
     where uo.organization_id = p_org and uo.provisional_until_handover and uo.user_id <> p_user;
  end if;
  return jsonb_build_object('id', m.id, 'changed', true);
end $$;
revoke all on function public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb) to service_role;

notify pgrst, 'reload schema';
