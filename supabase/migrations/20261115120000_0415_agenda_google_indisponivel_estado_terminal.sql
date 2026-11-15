-- 0415 — Agenda do Google indisponível vira estado terminal no claim
--
-- Portado do DeskcommCRM original (PR #4453 de @webtecnica, issue #4448),
-- reescrito sobre o corpo de `fn_google_appointment` deste fork (0337 + 0358).
--
-- ── O laço ────────────────────────────────────────────────────────────────────
-- Compromisso já publicado apontando para uma agenda que o CRM marcou
-- `available=false` (ela sumiu da lista da conta Google) era reivindicado a cada
-- 5 minutos pelo cron `agenda-google-push`: o `claim` aceitava (a checagem de
-- disponibilidade só existia para quem AINDA NÃO tinha evento), o executor lia o
-- Google, `idle`/`commit` batia na guarda `not c.available` e levantava
-- `google_connection_unavailable` (42501). O executor traduzia QUALQUER erro de
-- banco com `code` para "O compromisso mudou. A sincronização vai reler a versão
-- atual.", a ação `error` remarcava +15 min, e o ciclo se repetia para sempre.
--
-- ── O conserto, em duas metades ───────────────────────────────────────────────
--  1. o `claim` confere a agenda de destino ANTES de aceitar, também para quem
--     já foi publicado. Indisponível = `{terminal:'calendar_unavailable'}`, o
--     motivo vai para `google_sync_error` e `google_next_attempt_at` vai para
--     `infinity`: sem lease, sem leitura no Google, fora da fila;
--  2. o gatilho `trg_google_agenda_disponivel_de_novo` devolve à fila
--     (`google_next_attempt_at = now()`) todo compromisso estacionado daquela
--     agenda no instante em que ela volta a `available=true` — na conferência
--     diária do catálogo (`fn_google_catalog`) ou pelo botão "Atualizar lista e
--     sincronização". Ninguém rearma compromisso por compromisso.
--
-- A frase gravada aqui é a MESMA que `lib/agenda/google/sync-executor.ts` usa
-- para o 42501 `google_connection_unavailable`, que deixou de virar "o
-- compromisso mudou".
--
-- ── Fora deste conserto (como no original) ────────────────────────────────────
--  * compromisso ainda NÃO publicado em agenda indisponível: segue com a frase
--    própria e nova tentativa em 15 min;
--  * conexão `status<>'healthy'`: a guarda 42501 também a cobre e agora mostra a
--    frase da agenda, mas segue tentando em 15 min;
--  * Meet pendente: `fn_meet_stamp` reancora a tentativa com `least(...)`, que
--    não preserva `infinity`; o claim recusa de novo no compasso do Meet, sem
--    ler o Google e sem escrever `error`.
--
-- Sem tabela, coluna ou constraint nova. Idempotente (`create or replace`).
-- Prova: `tests/invariants/agenda-google-reconciliacao.test.ts` (#4448) e
-- `tests/unit/agenda-google-banco-recusa-nao-vira-versao-atual.test.ts`.

create or replace function public.fn_google_appointment(p_org uuid,p_id uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; c public.calendar_connection_calendars; conn public.calendar_connections;
 contact uuid; claim jsonb:=p_args->'claim'; result jsonb; b jsonb; changed boolean; remote jsonb;
begin
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002';end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 -- Seleção/reserva compartilham membership antes dos locks de calendário/appointment.
 perform 1 from public.user_organizations m join public.calendar_appointments x on x.organization_id=m.organization_id and x.owner_user_id=m.user_id
  where x.organization_id=p_org and x.id=p_id for update of m;
 if p_args?'calendar_fence' then
  perform public.fn_google_calendar_fence(p_org,(p_args->'calendar_fence'->>'id')::uuid,p_args->'calendar_fence'->'claim',p_args->'calendar_fence'->'cursor');
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='PT409';end if;
 if contact is not null and exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  if p_action='claim' then return jsonb_build_object('terminal','redacted');end if;
  raise exception 'google_contact_redacted' using errcode='42501';end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null) then
  raise exception 'google_owner_unavailable' using errcode='42501';end if;
 if p_action='claim' then
  if a.google_claim_until>clock_timestamp() then return null;end if;
  if a.google_event_id is not null then
   -- ESTADO TERMINAL (0415): compromisso já publicado cuja agenda de destino o
   -- CRM marcou `available=false` não é reivindicado, nem para LER o Google.
   -- `infinity` tira o compromisso da fila (`google_next_attempt_at<=now()`)
   -- ENQUANTO a agenda estiver assim; `trg_google_agenda_disponivel_de_novo`
   -- devolve à fila quando ela volta. O erro gravado é o MOTIVO.
   select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
   if c.id is not null and not c.available then
    update public.calendar_appointments set google_sync_error='A agenda de destino não aparece mais na conta Google. A sincronização volta sozinha se ela reaparecer; para adiantar, use "Atualizar lista e sincronização" nas configurações da agenda.',google_next_attempt_at='infinity'::timestamptz where organization_id=p_org and id=p_id;
    return jsonb_build_object('terminal','calendar_unavailable');end if;
  end if;
  if a.google_event_id is null and a.status<>'cancelled' then
   select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
    where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination;
   if not found or (select count(*) from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination)<>1 then
    update public.calendar_appointments set google_sync_error='Escolha uma agenda de destino nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;
   end if;
   if not c.available or c.access_role not in ('owner','writer') then
    update public.calendar_appointments set google_sync_error='A agenda de destino não permite publicação. Confira o acesso nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;end if;
   update public.calendar_appointments set google_connection_id=c.connection_id,google_calendar_id=c.external_calendar_id,
    google_event_id='deskcommapp'||replace(id::text,'-',''),google_pending_write='{"reservation":true}'::jsonb where organization_id=p_org and id=p_id returning * into a;
  end if;
  update public.calendar_appointments set google_claim_token=gen_random_uuid(),google_claim_epoch=google_claim_epoch+1,
   google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
 else
  if a.google_claim_token is distinct from (claim->>'token')::uuid or a.google_claim_epoch::text is distinct from claim->>'epoch'
   or a.google_claim_until is null or a.google_claim_until<=clock_timestamp() then raise exception 'google_stale' using errcode='PT409';end if;
  if p_action='renew' then
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'google_stale' using errcode='PT409';end if;
   if not exists(select 1 from public.calendar_connections x join public.calendar_connection_calendars k on k.organization_id=x.organization_id and k.connection_id=x.id
    where x.organization_id=p_org and x.id=a.google_connection_id and x.user_id=a.owner_user_id and x.status='healthy' and k.external_calendar_id=a.google_calendar_id and k.available and k.access_role in ('writer','owner')) then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   update public.calendar_appointments set google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
  elsif p_action='release' then
   update public.calendar_appointments set google_claim_token=null,google_claim_until=null where organization_id=p_org and id=p_id;return 'true';
  else
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision'
    or a.google_event_id is distinct from p_args->>'event_id' or a.google_connection_id::text is distinct from p_args->>'connection_id'
    or a.google_calendar_id is distinct from p_args->>'calendar_id' then raise exception 'google_stale' using errcode='PT409';end if;
   if p_action='error' then
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_next_attempt_at=now()+interval '15 minutes',
     meeting_state=case when meeting_state='pending' and meeting_attempts>=19 then 'failed' else meeting_state end,
     meeting_last_error=case when meeting_state='pending' then 'unknown' else meeting_last_error end,
     meeting_attempts=meeting_attempts+case when meeting_state='pending' then 1 else 0 end,
     meeting_next_attempt_at=case when meeting_state='pending' then now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)) else meeting_next_attempt_at end
     where organization_id=p_org and id=p_id;return 'true';end if;
   if a.google_event_id is not null then
    select * into conn from public.calendar_connections where organization_id=p_org and id=a.google_connection_id and user_id=a.owner_user_id;
    select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
    if conn.id is null or conn.status<>'healthy' or c.id is null or not c.available then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   end if;
   if p_action='meet' then
    perform public.fn_meet_observe(p_org,p_id,p_args);
    select * into a from public.calendar_appointments where organization_id=p_org and id=p_id;
   elsif p_action='prepare' then
    if c.access_role not in ('owner','writer') or (a.google_pending_write is not null and a.google_pending_write<>'{"reservation":true}'::jsonb) or a.google_conflict is not null then raise exception 'google_write_unavailable' using errcode='PT409';end if;
    if p_args->'operation'?'conference_request_id' and (a.meeting_request_id is distinct from (p_args->'operation'->>'conference_request_id')::uuid or a.meeting_state<>'pending' or a.meeting_received_at is not null or a.status='cancelled') then raise exception 'meet_stale' using errcode='PT409';end if;
    update public.calendar_appointments set meeting_requested_at=case when p_args->'operation'?'conference_request_id' then coalesce(meeting_requested_at,now()) else meeting_requested_at end,google_pending_write=p_args->'operation' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='idle' then
   -- idle = convergente sem nada a fazer e sem falha nesta rodada: erro
   -- guardado aqui e de rodada passada e nao pode sobreviver (upstream #2467).
    update public.calendar_appointments set google_sync_error=null,google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='commit' then
    result:=p_args->'result'; b:=result->'base';remote:=result->'remote';
    if result?'operation_id' and a.google_pending_write->>'operation_id' is distinct from result->>'operation_id' then raise exception 'google_stale' using errcode='PT409';end if;
    if result?'apply_remote' then
     if a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
     if not coalesce((remote->>'cancelled')::boolean,false) and exists(select 1 from public.calendar_appointments other
      where other.organization_id=p_org and other.owner_user_id=a.owner_user_id and other.id<>a.id and other.status in ('pending','confirmed')
      and other.starts_at<(remote->>'ends_at')::timestamptz and other.ends_at>(remote->>'starts_at')::timestamptz) then
      return jsonb_build_object('overlap',true);end if;
     changed:=row(a.starts_at,a.ends_at,a.time_zone,a.status='cancelled') is distinct from row((remote->>'starts_at')::timestamptz,(remote->>'ends_at')::timestamptz,remote->>'time_zone',(remote->>'cancelled')::boolean);
     perform public.fn_appointment_change_core(p_org,p_id,a.revision,
      jsonb_build_object('starts_at',remote->>'starts_at','ends_at',remote->>'ends_at','time_zone',remote->>'time_zone')||
      case when (remote->>'cancelled')::boolean then '{"status":"cancelled","cancellation_reason":"Cancelado no Google"}'::jsonb else '{}'::jsonb end,true,b);
     if changed then
      insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
       select p_org,l.lead_id,a.contact_id,case when (remote->>'cancelled')::boolean then 'appointment_cancelled' else 'appointment_rescheduled' end,
        'agenda',p_id,'system',case when (remote->>'cancelled')::boolean then 'Cancelado no Google' else 'Remarcado no Google' end,jsonb_build_object('origin','google','appointment_id',p_id,'resolution_actor_id',a.google_conflict->'resolution'->>'actor_id')
       from public.crm_lead_links l where l.organization_id=p_org and l.target_id=p_id and l.target_kind='appointment' group by l.lead_id;
     end if;
    end if;
    update public.calendar_appointments set
     google_base_projection=case when result?'base' then b else google_base_projection end,
     google_etag=case when result?'etag' then result->>'etag' else google_etag end,
     google_conflict=case when result?'conflict' then nullif(result->'conflict','null'::jsonb) else google_conflict end,
     google_pending_write=case when coalesce((result->>'retry_creation')::boolean,false) and a.google_base_projection is null and a.google_pending_write->>'method'='POST'
      then '{"reservation":true}'::jsonb when coalesce((result->>'clear_pending')::boolean,false) then null else google_pending_write end,
     google_synced_local_revision=case when coalesce((result->>'ack')::boolean,false) then a.google_local_revision else google_synced_local_revision end,
     google_synced_at=case when coalesce((result->>'ack')::boolean,false) then now() else google_synced_at end,
     google_sync_error=null,google_next_attempt_at=now()+interval '5 minutes'
     where organization_id=p_org and id=p_id returning * into a;
   else raise exception 'google_action_invalid' using errcode='22023';end if;
  end if;
 end if;
 return to_jsonb(a)||jsonb_build_object('revision',a.revision::text,'google_local_revision',a.google_local_revision::text,
  'google_synced_local_revision',a.google_synced_local_revision::text,'meeting_allowed_types',(select allowed_conference_types from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id),'claim',jsonb_build_object('token',a.google_claim_token,'epoch',a.google_claim_epoch::text,'lease_until',a.google_claim_until));
end;$$;

revoke execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) to service_role;

create or replace function public.fn_google_agenda_disponivel_de_novo() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if coalesce(new.available,false) and not coalesce(old.available,false) then
  update public.calendar_appointments set google_next_attempt_at=now()
   where organization_id=new.organization_id and google_connection_id=new.connection_id
     and google_calendar_id=new.external_calendar_id
     and google_next_attempt_at='infinity'::timestamptz;
 end if;
 return new;
end;$$;
revoke all on function public.fn_google_agenda_disponivel_de_novo() from public,anon,authenticated;
grant execute on function public.fn_google_agenda_disponivel_de_novo() to service_role;
create or replace trigger trg_google_agenda_disponivel_de_novo
 after update of available on public.calendar_connection_calendars
 for each row execute function public.fn_google_agenda_disponivel_de_novo();
notify pgrst,'reload schema';
