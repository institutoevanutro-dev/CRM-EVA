-- 0320: histórico é registro, sem convites, lembretes ou automações.
alter table public.calendar_appointments add column if not exists history_import_key text;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_source_check;
alter table public.calendar_appointments add constraint calendar_appointments_source_check
 check(source in ('ui','mcp','google_sync','public_page','historical_import'));
alter table public.calendar_appointments drop constraint if exists calendar_appointments_history_key_check;
alter table public.calendar_appointments add constraint calendar_appointments_history_key_check
 check ((source='historical_import' and history_import_key is not null and history_import_key ~ '^[a-f0-9]{64}$')
     or (source<>'historical_import' and history_import_key is null));
create unique index if not exists calendar_appointments_history_key
 on public.calendar_appointments(organization_id,history_import_key) where history_import_key is not null;

-- Só o importador administrativo escreve o histórico; a API normal não o transforma
-- em compromisso vivo. Redações LGPD e repontamento de contato continuam possíveis.
create or replace function public.fn_appointment_history_guard()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' and (new.source is distinct from old.source or new.history_import_key is distinct from old.history_import_key)
   and (old.source='historical_import' or new.source='historical_import') then
  raise exception 'history_origin_immutable' using errcode='42501';
 end if;
 if new.source<>'historical_import' then return new;end if;
 if tg_op='INSERT' and current_user in ('anon','authenticated') then
  raise exception 'history_import_admin_only' using errcode='42501';
 end if;
 if new.ends_at>now() or new.event_type_id is not null or new.conversation_id is not null
  or new.guest_email is not null or new.google_event_id is not null or new.google_connection_id is not null
  or new.google_calendar_id is not null or new.location_kind<>'in_person' or new.meeting_url is not null
  or new.google_conflict is not null or new.google_pending_write is not null or new.google_claim_token is not null
  or new.meeting_state<>'not_requested' or new.meeting_request_id is not null or new.meeting_delivery_job_id is not null
  or new.meeting_delivery->>'state' not in ('none','blocked') then
  raise exception 'history_import_invalid' using errcode='22023';
 end if;
 if tg_op='UPDATE' and row(new.organization_id,new.starts_at,new.ends_at,new.status,new.time_zone)
  is distinct from row(old.organization_id,old.starts_at,old.ends_at,old.status,old.time_zone) then
  raise exception 'history_import_read_only' using errcode='42501';
 end if;
 if tg_op='UPDATE' and new.owner_user_id is distinct from old.owner_user_id
  and not (new.owner_user_id is null and not exists(select 1 from auth.users where id=old.owner_user_id)) then
  raise exception 'history_import_read_only' using errcode='42501';
 end if;
 return new;
end;$$;
revoke all on function public.fn_appointment_history_guard() from public,anon,authenticated;
drop trigger if exists trg_aaa_appointment_history_guard on public.calendar_appointments;
create trigger trg_aaa_appointment_history_guard before insert or update on public.calendar_appointments
 for each row execute function public.fn_appointment_history_guard();

create or replace function public.fn_google_projection_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; inbound boolean; decision boolean; redacted boolean;
begin
 -- Histórico nunca pertence à fila de sincronização nem recebe convite.
 if new.source='historical_import' then
  new.google_local_revision:=case when tg_op='INSERT' then 1 else old.google_local_revision end;
  new.google_synced_local_revision:=new.google_local_revision;
  return new;
 end if;
 redacted:=new.contact_id is not null and exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and is_anonymized);
 if redacted then
  new.google_base_projection:=null;new.google_conflict:=null;new.google_pending_write:=null;new.google_claim_token:=null;new.google_claim_until:=null;new.google_etag:=null;new.guest_email:=null;
  if tg_op='UPDATE' then new.google_claim_epoch:=old.google_claim_epoch+1;new.google_local_revision:=old.google_local_revision;new.google_synced_local_revision:=old.google_local_revision;end if;
  return new;
 end if;
 if tg_op='INSERT' then
  new.google_local_revision:=1;new.google_synced_local_revision:=0;
  if auth.uid() is not null then
   new.google_base_projection:=null;new.google_etag:=null;new.google_pending_write:=null;new.google_conflict:=null;
   new.google_claim_token:=null;new.google_claim_epoch:=0;new.google_claim_until:=null;
   new.google_connection_id:=null;new.google_calendar_id:=null;new.google_event_id:=null;
  end if;
  return new;
 end if;
 decision:=auth.uid()=old.owner_user_id and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
  and old.google_conflict is not null and new.google_conflict-'resolution'=old.google_conflict-'resolution'
  and new.google_conflict->'resolution'->>'actor_id'=auth.uid()::text
  and new.google_conflict->'resolution'->>'choice' in ('google','local','preserve_remote')
  and old.google_conflict->>'revision'=old.revision::text and old.google_conflict->>'local_revision'=old.google_local_revision::text
  and old.google_conflict->>'etag' is not distinct from old.google_etag;
 if auth.uid() is not null and (row(new.google_synced_at,new.google_sync_error) is distinct from row(old.google_synced_at,old.google_sync_error)
  or (new.google_next_attempt_at is distinct from old.google_next_attempt_at and not coalesce(auth.uid()=old.owner_user_id and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
    and new.google_next_attempt_at<=clock_timestamp() and (old.google_conflict is null or decision),false))) then
  raise exception 'google_metadata_private' using errcode='42501';end if;
 if auth.uid() is not null and ((new.google_conflict is distinct from old.google_conflict and not coalesce(decision,false)) or row(new.google_base_projection,new.google_pending_write,new.google_claim_token,new.google_claim_epoch,new.google_claim_until,new.google_synced_local_revision,new.google_etag,new.google_connection_id,new.google_calendar_id,new.google_event_id)
  is distinct from row(old.google_base_projection,old.google_pending_write,old.google_claim_token,old.google_claim_epoch,old.google_claim_until,old.google_synced_local_revision,old.google_etag,old.google_connection_id,old.google_calendar_id,old.google_event_id)) then
  raise exception 'google_metadata_private' using errcode='42501';
 end if;
 changed:=row(new.starts_at,new.ends_at,new.time_zone,new.status='cancelled',new.title,new.description,new.location_kind,new.location_details,new.guest_email)
  is distinct from row(old.starts_at,old.ends_at,old.time_zone,old.status='cancelled',old.title,old.description,old.location_kind,old.location_details,old.guest_email);
 -- Única entrada que modifica base e domínio juntos é o núcleo service-only.
 -- Não há GUC ou flag no body público que suprima revisão.
 inbound:=row(new.title,new.description,new.location_kind,new.location_details,new.guest_email) is not distinct from row(old.title,old.description,old.location_kind,old.location_details,old.guest_email) and auth.uid() is null and new.google_base_projection is distinct from old.google_base_projection
  and (new.google_base_projection->'shared'->>'starts_at')::timestamptz=new.starts_at
  and (new.google_base_projection->'shared'->>'ends_at')::timestamptz=new.ends_at
  and new.google_base_projection->'shared'->>'time_zone'=new.time_zone
  and (new.google_base_projection->'shared'->>'cancelled')::boolean=(new.status='cancelled');
 new.google_local_revision:=old.google_local_revision+case when changed and not coalesce(inbound,false) then 1 else 0 end;
 if changed then new.google_next_attempt_at:=now(); end if;
 return new;
end;$$;
revoke all on function public.fn_google_projection_stamp() from public,anon,authenticated;

create or replace function public.fn_marcar_contato_como_cliente()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_ligado boolean;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
  else
    v_org := new.organization_id;
  end if;

  -- Espera a ligação em voo commitar. O SELECT abaixo é outro comando, então
  -- em READ COMMITTED tira snapshot novo e enxerga a chave já gravada.
  perform pg_advisory_xact_lock_shared(hashtextextended(v_org::text, 262));

  -- Comparar com 'true'::jsonb nunca lança erro. Um `::boolean` abortaria a
  -- marcação do horário se alguém gravasse lixo na chave.
  select (o.settings -> 'crm' -> 'cliente_pela_agenda') = 'true'::jsonb
    into v_ligado
    from public.organizations o
   where o.id = v_org;

  if v_ligado is not true then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.fn_recalcular_cliente_do_contato(v_org, new.contact_id, new.source <> 'historical_import');
  elsif tg_op = 'UPDATE' then
    if new.contact_id is not null then
      -- O CONTATO DO HORÁRIO MUDOU — e a condição `is distinct from` tem DUAS
      -- causas, não uma. A primeira é o repontamento de `fn_mesclar_contatos`
      -- (X → Y): o horário só trocou de cadastro, e a escrita no vencedor não é
      -- a virada que as automações devem ver. A segunda é o PRIMEIRO vínculo de
      -- um horário que nasceu sem contato (null → Y), e esse é reconhecimento
      -- de verdade: é a primeira vez que este contato tem horário, e emite como
      -- um INSERT emitiria. Medido antes desta linha: no caminho null → Y o
      -- contato virava cliente, ganhava a etiqueta, ficava com
      -- `client_recognized_at` carimbado — e NENHUM `contact.tag_added` saía,
      -- nem ali nem nunca mais, porque o carimbo não volta a null.
      perform public.fn_recalcular_cliente_do_contato(
        v_org, new.contact_id,
        new.source <> 'historical_import' and (old.contact_id is not distinct from new.contact_id or old.contact_id is null));
    end if;
    if old.contact_id is not null and old.contact_id is distinct from new.contact_id then
      perform public.fn_recalcular_cliente_do_contato(v_org, old.contact_id, false);
    end if;
  else
    perform public.fn_recalcular_cliente_do_contato(v_org, old.contact_id, false);
  end if;

  return null;
end $$;
revoke all on function public.fn_marcar_contato_como_cliente() from public,anon,authenticated;

create or replace function public.fn_appointment_confirmation_sweep(p_limit int default 100,p_now timestamptz default now())
returns int language plpgsql security definer set search_path=public as $$
declare a record; candidate record; n int:=0; expired boolean;
begin
 -- Escolhe o mesmo lote vencido e obtém mutexes em ordem, sem row lock prévio.
 for candidate in select * from (
  select c.id,c.organization_id,c.contact_id,c.ends_at
  from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
  where c.status in ('pending','confirmed') and c.source <> 'historical_import'
   and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
   and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
   and not exists(select 1 from public.contacts ct where ct.organization_id=c.organization_id and ct.id=c.contact_id and ct.is_anonymized)
  order by c.ends_at,c.id limit greatest(1,least(p_limit,500))
 ) due order by organization_id,contact_id,id
 loop
  if candidate.contact_id is not null and not pg_try_advisory_xact_lock(hashtextextended(candidate.organization_id::text||':'||candidate.contact_id::text,222)) then continue;end if;
  select c.*,o.settings into a from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
   where c.id=candidate.id and c.organization_id=candidate.organization_id and c.contact_id is not distinct from candidate.contact_id
    and c.status in ('pending','confirmed') and c.source <> 'historical_import'
    and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
    and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
    and not exists(select 1 from public.contacts ct where ct.organization_id=c.organization_id and ct.id=c.contact_id and ct.is_anonymized)
   for update of c skip locked;
  if not found then continue;end if;
  expired:=a.ends_at+make_interval(mins=>public.fn_agenda_minutes(a.settings,'unknown_protection_minutes',1440))<=p_now;
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   values(a.organization_id,'appointment_outcome_required',case when expired then 'critical' else 'warn' end,
    case when expired then 'Presença sem confirmação há mais tempo' else 'Confirme a presença no compromisso' end,
    'Compromisso: '||a.title||'. Abra e registre se a pessoa compareceu, faltou ou cancelou. O horário sozinho não confirma falta.',
    'appointment',a.id,a.revision)
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null
   do update set status='open',resolved_at=null,severity=excluded.severity,title=excluded.title;
  update public.calendar_appointments set confirmation_next_at=case when expired then p_now+interval '24 hours' else least(p_now+interval '24 hours',a.ends_at+make_interval(mins=>public.fn_agenda_minutes(a.settings,'unknown_protection_minutes',1440))) end where id=a.id and organization_id=a.organization_id;
  n:=n+1;
 end loop;
 return n;
end; $$;
revoke all on function public.fn_appointment_confirmation_sweep(int,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_appointment_confirmation_sweep(int,timestamptz) to service_role;
notify pgrst,'reload schema';
