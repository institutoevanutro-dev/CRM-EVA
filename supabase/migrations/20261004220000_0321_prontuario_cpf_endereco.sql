-- Cadastro administrativo ampliado. As RPCs antigas continuam disponíveis.
-- CPF nunca entra em JSON de contato/auditoria: usa o par cifrado + HMAC existente.
create or replace function public.fn_prontuario_address_merge(p_current jsonb,p_address jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare v_parts jsonb; v_in jsonb; v_text text; v_old jsonb; v_old_text text;
begin
 if p_address is null or p_address='{}'::jsonb then return coalesce(p_current,'{}'::jsonb); end if;
 if jsonb_typeof(p_address)<>'object' then raise exception 'prontuario_input_invalid'; end if;
 if exists(select 1 from jsonb_each(p_address) e where e.key not in ('cep','logradouro','numero','complemento','bairro','cidade','uf') or jsonb_typeof(e.value)<>'string' or length(e.value#>>'{}')>200) then raise exception 'prontuario_input_invalid'; end if;
 select coalesce(jsonb_object_agg(key,btrim(value)),'{}'::jsonb) into v_in from jsonb_each_text(p_address) where btrim(value)<>'';
 if v_in='{}'::jsonb then return coalesce(p_current,'{}'::jsonb); end if;
 v_old:=case when jsonb_typeof(p_current->'endereco_estruturado')='object' then p_current->'endereco_estruturado' else '{}'::jsonb end;
 v_old_text:=concat_ws(', ',nullif(v_old->>'logradouro',''),nullif(v_old->>'numero',''),nullif(v_old->>'complemento',''),nullif(v_old->>'bairro',''),nullif(v_old->>'cidade',''),nullif(v_old->>'uf',''),nullif(v_old->>'cep',''));
 v_parts:=v_old||v_in;
 v_text:=concat_ws(', ',nullif(v_parts->>'logradouro',''),nullif(v_parts->>'numero',''),nullif(v_parts->>'complemento',''),nullif(v_parts->>'bairro',''),nullif(v_parts->>'cidade',''),nullif(v_parts->>'uf',''),nullif(v_parts->>'cep',''));
 -- A tela CRM edita texto livre. Não reconstruir esse texto a partir de partes
 -- antigas, nem tentar inferir componentes ausentes de um endereço legado.
 if coalesce(p_current?'endereco_estruturado',false) then
   if jsonb_typeof(p_current->'endereco_estruturado')<>'object' or (coalesce(p_current->>'endereco','')<>v_old_text and coalesce(p_current->>'endereco','')<>v_text) then raise exception 'prontuario_demographics_conflict'; end if;
 elsif coalesce(p_current->>'endereco','')<>'' and p_current->>'endereco'<>v_text then
   raise exception 'prontuario_demographics_conflict';
 end if;
 return coalesce(p_current,'{}'::jsonb)||jsonb_build_object('endereco_estruturado',v_parts,'endereco',v_text);
end; $$;
revoke execute on function public.fn_prontuario_address_merge(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_prontuario_address_merge(jsonb,jsonb) to service_role;

create or replace function public.fn_prontuario_create_contact_v2(
  p_org uuid, p_patient uuid, p_name text, p_birth date, p_phone text,
  p_email text, p_key uuid, p_token uuid, p_cpf text, p_address jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_link public.prontuario_contact_links%rowtype; v_contact public.contacts%rowtype; v_hash text; v_cpf text; v_cpf_hash text; v_fields jsonb;
begin
  if p_key is null or p_name is null or length(btrim(p_name)) < 2 then raise exception 'prontuario_input_invalid'; end if;
  if not exists(select 1 from public.api_tokens where id=p_token and organization_id=p_org and revoked_at is null and scopes @> '["prontuario:contacts:write"]'::jsonb) then
    raise exception 'prontuario_token_invalid';
  end if;
  v_cpf:=nullif(regexp_replace(coalesce(p_cpf,''),'[.\s-]','','g'),'');
  if v_cpf is not null then
    if v_cpf !~ '^\d{11}$' or v_cpf ~ '^(.)\1{10}$' then raise exception 'prontuario_input_invalid'; end if;
    v_cpf_hash:=public.cpf_indice(v_cpf);
  end if;
  v_hash := md5(jsonb_build_object('name',p_name,'birthdate',p_birth,'phone_number',nullif(p_phone,''),'email',nullif(p_email,''))::text);
  if v_cpf_hash is not null or coalesce(p_address,'{}'::jsonb)<>'{}'::jsonb then
    v_hash:=md5(jsonb_build_object('profile',v_hash,'cpf_index',v_cpf_hash,'address',p_address)::text);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('prontuario:'||p_org::text||':'||p_patient::text, 0));
  select * into v_link from public.prontuario_contact_links
   where organization_id=p_org and source_patient_id=p_patient for update;
  if found then
    if v_link.create_request_key is distinct from p_key then raise exception 'prontuario_link_conflict'; end if;
    if v_link.create_payload_hash is distinct from v_hash then raise exception 'prontuario_request_conflict'; end if;
    select * into v_contact from public.contacts where id=v_link.contact_id and organization_id=p_org;
    if not found or v_contact.is_anonymized or v_contact.is_merged_into is not null then
      raise exception 'prontuario_contact_unavailable';
    end if;
    return jsonb_build_object('id',v_contact.id,'updated_at',v_contact.updated_at,'created',false);
  end if;
  if exists(select 1 from public.prontuario_contact_links where organization_id=p_org and create_request_key=p_key) then
    raise exception 'prontuario_request_conflict';
  end if;
  v_fields:=public.fn_prontuario_address_merge('{}'::jsonb,p_address);
  insert into public.contacts(organization_id,name,display_name,birthdate,phone_number,email,source,cpf_hash,cpf_encrypted,custom_fields)
  values(p_org,p_name,p_name,p_birth,nullif(p_phone,''),nullif(p_email,''),'prontuario_eva',v_cpf_hash,case when v_cpf is not null then public.encrypt_cpf(v_cpf) end,v_fields)
  returning * into v_contact;
  insert into public.prontuario_contact_links
    (organization_id,source_patient_id,contact_id,create_request_key,create_payload_hash,linked_by_api_token_id,last_crm_updated_at)
  values(p_org,p_patient,v_contact.id,p_key,v_hash,p_token,v_contact.updated_at);
  return jsonb_build_object('id',v_contact.id,'updated_at',v_contact.updated_at,'created',true);
end; $$;

create or replace function public.fn_prontuario_patch_contact_v2(
  p_org uuid, p_patient uuid, p_contact uuid, p_revision integer, p_expected timestamptz,
  p_name text, p_birth date, p_phone text, p_email text, p_token uuid, p_cpf text, p_address jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_link public.prontuario_contact_links%rowtype; v_contact public.contacts%rowtype; v_hash text; v_cpf text; v_cpf_hash text; v_fields jsonb;
begin
  if p_name is null or length(btrim(p_name)) < 2 or p_revision is null then raise exception 'prontuario_input_invalid'; end if;
  if not exists(select 1 from public.api_tokens where id=p_token and organization_id=p_org and revoked_at is null and scopes @> '["prontuario:contacts:write"]'::jsonb) then
    raise exception 'prontuario_token_invalid';
  end if;
  if p_revision < 0 then raise exception 'prontuario_revision_conflict'; end if;
  v_cpf:=nullif(regexp_replace(coalesce(p_cpf,''),'[.\s-]','','g'),'');
  if v_cpf is not null then
    if v_cpf !~ '^\d{11}$' or v_cpf ~ '^(.)\1{10}$' then raise exception 'prontuario_input_invalid'; end if;
    v_cpf_hash:=public.cpf_indice(v_cpf);
  end if;
  v_hash := md5(jsonb_build_object('name',p_name,'birthdate',p_birth,'phone_number',nullif(p_phone,''),'email',nullif(p_email,''))::text);
  if v_cpf_hash is not null or coalesce(p_address,'{}'::jsonb)<>'{}'::jsonb then
    v_hash:=md5(jsonb_build_object('profile',v_hash,'cpf_index',v_cpf_hash,'address',p_address)::text);
  end if;
  select * into v_link from public.prontuario_contact_links
   where organization_id=p_org and source_patient_id=p_patient and contact_id=p_contact for update;
  if not found then raise exception 'prontuario_link_unavailable'; end if;
  select * into v_contact from public.contacts where id=p_contact and organization_id=p_org for update;
  if not found or v_contact.is_anonymized or v_contact.is_merged_into is not null then
    raise exception 'prontuario_contact_unavailable';
  end if;
  if p_revision = v_link.last_source_revision then
    if v_hash is distinct from v_link.last_payload_hash then raise exception 'prontuario_request_conflict'; end if;
    if v_contact.updated_at is distinct from v_link.last_crm_updated_at then raise exception 'prontuario_revision_conflict'; end if;
    return jsonb_build_object('id',p_contact,'updated_at',v_link.last_crm_updated_at,'revision',p_revision,'applied',false);
  end if;
  if p_revision < v_link.last_source_revision or v_contact.updated_at is distinct from p_expected then
    raise exception 'prontuario_revision_conflict';
  end if;
  if v_cpf_hash is not null and v_contact.cpf_hash is not null and v_contact.cpf_hash<>v_cpf_hash then raise exception 'prontuario_demographics_conflict'; end if;
  v_fields:=public.fn_prontuario_address_merge(v_contact.custom_fields,p_address);
  update public.contacts set name=p_name,display_name=p_name,birthdate=coalesce(p_birth,birthdate),
    phone_number=coalesce(nullif(p_phone,''),phone_number),email=coalesce(nullif(p_email,''),email),
    cpf_hash=coalesce(v_cpf_hash,cpf_hash),cpf_encrypted=case when v_cpf is null then cpf_encrypted else public.encrypt_cpf(v_cpf) end,
    custom_fields=v_fields
   where id=p_contact and organization_id=p_org returning * into v_contact;
  update public.prontuario_contact_links set last_source_revision=p_revision,
    last_payload_hash=v_hash,last_crm_updated_at=v_contact.updated_at
   where id=v_link.id;
  return jsonb_build_object('id',p_contact,'updated_at',v_contact.updated_at,'revision',p_revision,'applied',true);
end; $$;

revoke execute on function public.fn_prontuario_create_contact_v2(uuid,uuid,text,date,text,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke execute on function public.fn_prontuario_patch_contact_v2(uuid,uuid,uuid,integer,timestamptz,text,date,text,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_prontuario_create_contact_v2(uuid,uuid,text,date,text,text,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.fn_prontuario_patch_contact_v2(uuid,uuid,uuid,integer,timestamptz,text,date,text,text,uuid,text,jsonb) to service_role;
