-- Operações transacionais do cadastro mestre do prontuário EVA.
-- API valida Bearer/escopo e passa organization_id da linha do token.
alter table public.prontuario_contact_links
  add column if not exists last_source_revision integer not null default -1,
  add column if not exists last_payload_hash text,
  add column if not exists last_crm_updated_at timestamptz;

create or replace function public.fn_prontuario_link_existing(
  p_org uuid, p_patient uuid, p_contact uuid, p_expected timestamptz, p_token uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_link public.prontuario_contact_links%rowtype; v_contact public.contacts%rowtype;
begin
  if not exists(select 1 from public.api_tokens where id=p_token and organization_id=p_org and revoked_at is null) then
    raise exception 'prontuario_token_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('prontuario:'||p_org::text||':'||p_patient::text, 0));
  select * into v_link from public.prontuario_contact_links
   where organization_id=p_org and source_patient_id=p_patient for update;
  if found then
    if v_link.contact_id <> p_contact then raise exception 'prontuario_link_conflict'; end if;
    select * into v_contact from public.contacts where id=p_contact and organization_id=p_org;
    if not found or v_contact.is_anonymized or v_contact.is_merged_into is not null then
      raise exception 'prontuario_contact_unavailable';
    end if;
    return jsonb_build_object('id',v_contact.id,'updated_at',v_contact.updated_at,'linked',false);
  end if;
  select * into v_contact from public.contacts where id=p_contact and organization_id=p_org for update;
  if not found or v_contact.is_anonymized or v_contact.is_merged_into is not null then
    raise exception 'prontuario_contact_unavailable';
  end if;
  if v_contact.updated_at is distinct from p_expected then raise exception 'prontuario_revision_conflict'; end if;
  insert into public.prontuario_contact_links
    (organization_id,source_patient_id,contact_id,linked_by_api_token_id,last_crm_updated_at)
  values (p_org,p_patient,p_contact,p_token,v_contact.updated_at);
  return jsonb_build_object('id',v_contact.id,'updated_at',v_contact.updated_at,'linked',true);
end; $$;

create or replace function public.fn_prontuario_create_contact(
  p_org uuid, p_patient uuid, p_name text, p_birth date, p_phone text,
  p_email text, p_key uuid, p_token uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_link public.prontuario_contact_links%rowtype; v_contact public.contacts%rowtype;
begin
  if p_key is null or p_name is null or length(btrim(p_name)) < 2 then raise exception 'prontuario_input_invalid'; end if;
  if not exists(select 1 from public.api_tokens where id=p_token and organization_id=p_org and revoked_at is null) then
    raise exception 'prontuario_token_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('prontuario:'||p_org::text||':'||p_patient::text, 0));
  select * into v_link from public.prontuario_contact_links
   where organization_id=p_org and source_patient_id=p_patient for update;
  if found then
    if v_link.create_request_key is distinct from p_key then raise exception 'prontuario_link_conflict'; end if;
    select * into v_contact from public.contacts where id=v_link.contact_id and organization_id=p_org;
    if not found or v_contact.is_anonymized or v_contact.is_merged_into is not null then
      raise exception 'prontuario_contact_unavailable';
    end if;
    return jsonb_build_object('id',v_contact.id,'updated_at',v_contact.updated_at,'created',false);
  end if;
  if exists(select 1 from public.prontuario_contact_links where organization_id=p_org and create_request_key=p_key) then
    raise exception 'prontuario_request_conflict';
  end if;
  insert into public.contacts(organization_id,name,display_name,birthdate,phone_number,email,source)
  values(p_org,p_name,p_name,p_birth,nullif(p_phone,''),nullif(p_email,''),'prontuario_eva')
  returning * into v_contact;
  insert into public.prontuario_contact_links
    (organization_id,source_patient_id,contact_id,create_request_key,linked_by_api_token_id,last_crm_updated_at)
  values(p_org,p_patient,v_contact.id,p_key,p_token,v_contact.updated_at);
  return jsonb_build_object('id',v_contact.id,'updated_at',v_contact.updated_at,'created',true);
end; $$;

create or replace function public.fn_prontuario_patch_contact(
  p_org uuid, p_patient uuid, p_contact uuid, p_revision integer, p_expected timestamptz,
  p_name text, p_birth date, p_phone text, p_email text, p_token uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_link public.prontuario_contact_links%rowtype; v_contact public.contacts%rowtype; v_hash text;
begin
  if p_name is null or length(btrim(p_name)) < 2 or p_revision is null then raise exception 'prontuario_input_invalid'; end if;
  if not exists(select 1 from public.api_tokens where id=p_token and organization_id=p_org and revoked_at is null) then
    raise exception 'prontuario_token_invalid';
  end if;
  if p_revision < 0 then raise exception 'prontuario_revision_conflict'; end if;
  v_hash := md5(jsonb_build_object('name',p_name,'birthdate',p_birth,'phone_number',nullif(p_phone,''),'email',nullif(p_email,''))::text);
  select * into v_link from public.prontuario_contact_links
   where organization_id=p_org and source_patient_id=p_patient and contact_id=p_contact for update;
  if not found then raise exception 'prontuario_link_unavailable'; end if;
  select * into v_contact from public.contacts where id=p_contact and organization_id=p_org for update;
  if not found or v_contact.is_anonymized or v_contact.is_merged_into is not null then
    raise exception 'prontuario_contact_unavailable';
  end if;
  if p_revision = v_link.last_source_revision then
    if v_hash is distinct from v_link.last_payload_hash then raise exception 'prontuario_request_conflict'; end if;
    return jsonb_build_object('id',p_contact,'updated_at',v_link.last_crm_updated_at,'revision',p_revision,'applied',false);
  end if;
  if p_revision < v_link.last_source_revision or v_contact.updated_at is distinct from p_expected then
    raise exception 'prontuario_revision_conflict';
  end if;
  update public.contacts set name=p_name,display_name=p_name,birthdate=p_birth,
    phone_number=nullif(p_phone,''),email=nullif(p_email,'')
   where id=p_contact and organization_id=p_org returning * into v_contact;
  update public.prontuario_contact_links set last_source_revision=p_revision,
    last_payload_hash=v_hash,last_crm_updated_at=v_contact.updated_at
   where id=v_link.id;
  return jsonb_build_object('id',p_contact,'updated_at',v_contact.updated_at,'revision',p_revision,'applied',true);
end; $$;

revoke execute on function public.fn_prontuario_link_existing(uuid,uuid,uuid,timestamptz,uuid) from public,anon,authenticated;
revoke execute on function public.fn_prontuario_create_contact(uuid,uuid,text,date,text,text,uuid,uuid) from public,anon,authenticated;
revoke execute on function public.fn_prontuario_patch_contact(uuid,uuid,uuid,integer,timestamptz,text,date,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_prontuario_link_existing(uuid,uuid,uuid,timestamptz,uuid) to service_role;
grant execute on function public.fn_prontuario_create_contact(uuid,uuid,text,date,text,text,uuid,uuid) to service_role;
grant execute on function public.fn_prontuario_patch_contact(uuid,uuid,uuid,integer,timestamptz,text,date,text,text,uuid) to service_role;
