-- Migration 0441 : O PACIENTE CONFIRMA A PRESENÇA RESPONDENDO AO LEMBRETE.
--
-- Pedido do dono em 27/11/2026: o lembrete da véspera passa a pedir que o
-- paciente confirme, e o CRM só LÊ a resposta. "Confirmado" aqui é "o paciente
-- disse que vem": uma marca SEPARADA do status. O compromisso continua
-- `confirmed` ("Agendado"); a expiração dos pendentes, o funil e o laço
-- `appointment.confirmed` não mudam. Design em
-- docs/superpowers/specs/2026-11-28-paciente-confirma-pelo-lembrete-design.md.
--
-- * calendar_appointments ganha 4 colunas anuláveis: patient_confirmed_at,
--   patient_confirmed_source ('mensagem' | 'equipe'), patient_confirmed_message_id
--   (a resposta do paciente) e patient_confirmed_user_id (quem da equipe marcou).
--   Coluna nova, sem valor legado: o CHECK de vocabulário entra, com o par em
--   lib/agenda/tipos.ts (ORIGENS_DA_CONFIRMACAO_DO_PACIENTE).
-- * calendar_event_types.reminder_asks_confirmation, DESLIGADA por padrão: nada
--   muda em clínica nenhuma até alguém ligar a chave no tipo.
-- * fn_appointment_stamp (corpo da 0401 com dois acréscimos):
--   - a confirmação vale para o horário confirmado: quando starts_at muda, as 4
--     colunas voltam a null, no mesmo UPDATE da remarcação;
--   - só o RPC grava as colunas. INSERT que as traga e UPDATE que as mude são
--     recusados com 42501 `patient_confirmation_rpc_only`, salvo com a marca
--     local `crm.confirmacao_do_paciente` ligada e sem sessão (mesmo mecanismo da
--     0401), e salvo o SET NULL da FK quando a mensagem ou a pessoa é apagada.
-- * fn_appointment_patient_confirm: o único caminho de gravação. Trava a linha,
--   só grava em compromisso `confirmed`, futuro e na revisão esperada, e devolve
--   'confirmado' | 'ja_confirmado' | 'nao_se_aplica'. Não incrementa a revisão:
--   fn_appointment_stamp só a incrementa quando starts_at, ends_at, status,
--   contact_id ou conversation_id mudam. Só service_role.
--
-- Idempotente: add column if not exists, constraint por consulta ao catálogo,
-- create or replace, revoke/grant.
alter table public.calendar_appointments
 add column if not exists patient_confirmed_at timestamptz,
 add column if not exists patient_confirmed_source text,
 add column if not exists patient_confirmed_message_id uuid references public.messages(id) on delete set null,
 add column if not exists patient_confirmed_user_id uuid references auth.users(id) on delete set null;
do $$
begin
 if not exists (
  select 1 from pg_constraint
   where conname = 'calendar_appointments_patient_confirmed_source_check'
     and conrelid = 'public.calendar_appointments'::regclass
 ) then
  alter table public.calendar_appointments
   add constraint calendar_appointments_patient_confirmed_source_check
   check (patient_confirmed_source in ('mensagem', 'equipe'));
 end if;
end $$;

alter table public.calendar_event_types
 add column if not exists reminder_asks_confirmation boolean not null default false;

create or replace function public.fn_appointment_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; actor uuid;
begin
 if new.contact_id is not null and not exists(select 1 from public.contacts where id=new.contact_id and organization_id=new.organization_id) then
  raise exception 'appointment_contact_scope' using errcode='23503'; end if;
 if new.conversation_id is not null and not exists(select 1 from public.conversations where id=new.conversation_id and organization_id=new.organization_id and contact_id=new.contact_id and not is_group and (auth.uid() is null or public.fn_can_view_conversation(organization_id,assigned_to_user_id))) then
  raise exception 'appointment_conversation_scope' using errcode='23503'; end if;
 if tg_op='INSERT' then
  new.revision:=1;
  -- Legado importado sem autoria não vira fato certificado.
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
  -- 0441: compromisso não nasce com a presença confirmada; só fn_appointment_patient_confirm a grava.
  if num_nonnulls(new.patient_confirmed_at,new.patient_confirmed_source,new.patient_confirmed_message_id,new.patient_confirmed_user_id)>0 then
   raise exception 'patient_confirmation_rpc_only' using errcode='42501',
    detail='A presença confirmada pelo paciente só é gravada por fn_appointment_patient_confirm.'; end if;
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
 -- 0441: só fn_appointment_patient_confirm grava a presença confirmada (marca local da
 -- transação, sem sessão, como na 0401). Única exceção: o SET NULL da FK quando a
 -- mensagem ou a pessoa é apagada, que é erosão de referência e não nova escrita.
 if row(new.patient_confirmed_at,new.patient_confirmed_source,new.patient_confirmed_message_id,new.patient_confirmed_user_id)
    is distinct from row(old.patient_confirmed_at,old.patient_confirmed_source,old.patient_confirmed_message_id,old.patient_confirmed_user_id)
  and not (auth.uid() is null and current_setting('crm.confirmacao_do_paciente',true)='on')
  and not (row(new.patient_confirmed_at,new.patient_confirmed_source) is not distinct from row(old.patient_confirmed_at,old.patient_confirmed_source)
   and (new.patient_confirmed_message_id is not distinct from old.patient_confirmed_message_id
    or (new.patient_confirmed_message_id is null and not exists(select 1 from public.messages where id=old.patient_confirmed_message_id)))
   and (new.patient_confirmed_user_id is not distinct from old.patient_confirmed_user_id
    or (new.patient_confirmed_user_id is null and not exists(select 1 from auth.users where id=old.patient_confirmed_user_id)))) then
  raise exception 'patient_confirmation_rpc_only' using errcode='42501',
   detail='A presença confirmada pelo paciente só é gravada por fn_appointment_patient_confirm.'; end if;
 -- 0441: a presença confirmada pelo paciente vale para o horário que ele confirmou.
 if new.starts_at is distinct from old.starts_at then
  new.patient_confirmed_at:=null; new.patient_confirmed_source:=null;
  new.patient_confirmed_message_id:=null; new.patient_confirmed_user_id:=null;
 end if;
 if new.status is distinct from old.status and new.status in ('completed','no_show') then
  actor:=auth.uid();
  -- 0401: "Realizado" informado pela integração do prontuário. Só chega aqui por
  -- fn_appointment_complete_by_integration (service_role), que liga a marca
  -- local da transação; sem sessão, só `completed`, e sem mensagem como prova.
  if actor is null and new.status='completed' and new.outcome_message_id is null
     and current_setting('crm.realizado_pela_integracao',true)='on' then
   if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
   new.outcome_user_id:=null; new.outcome_recorded_at:=clock_timestamp();
   new.outcome_source_kind:='integration';
   return new;
  end if;
  if actor is null or not public.fn_role_at_least(new.organization_id,'agent') or not public.fn_support_write_allowed(new.organization_id) then
   raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
  new.outcome_user_id:=actor; new.outcome_recorded_at:=clock_timestamp();
  new.outcome_source_kind:=case when new.outcome_message_id is null then 'user' else 'contact_message' end;
  if new.outcome_message_id is not null and not exists(
   select 1 from public.messages m join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
   where m.id=new.outcome_message_id and m.organization_id=new.organization_id and m.contact_id=new.contact_id
    and (new.conversation_id is null or m.conversation_id=new.conversation_id)
    and m.direction='inbound' and m.service_revision is not null and m.service_revision=c.service_revision
    and m.demanda_id is not distinct from c.current_demanda_id and m.created_at>=old.revision_started_at
    and not c.is_group and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
  ) then raise exception 'appointment_message_not_evidence' using errcode='42501'; end if;
 elsif changed then
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
 else
  new.outcome_source_kind:=old.outcome_source_kind;
  -- SET NULL por retenção da FK é erosão de referência, não nova autoria.
  new.outcome_user_id:=case when new.outcome_user_id is null and not exists(select 1 from auth.users where id=old.outcome_user_id) then null else old.outcome_user_id end;
  new.outcome_message_id:=case when new.outcome_message_id is null and not exists(select 1 from public.messages where id=old.outcome_message_id and organization_id=old.organization_id) then null else old.outcome_message_id end;
  new.outcome_recorded_at:=old.outcome_recorded_at;
 end if;
 return new;
end; $$;
revoke all on function public.fn_appointment_stamp() from public,anon,authenticated;

create or replace function public.fn_appointment_patient_confirm(
 p_appointment_id uuid, p_expected_revision int, p_source text, p_message_id uuid, p_user_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments;
begin
 if p_source is null or p_source not in ('mensagem','equipe')
  or (p_source='mensagem' and p_message_id is null) or (p_source='equipe' and p_user_id is null) then
  raise exception 'patient_confirm_invalid_source' using errcode='22023'; end if;
 -- Trava a linha: dois "SIM" seguidos, ou o SIM e o botão da recepção, gravam uma vez só.
 select * into a from public.calendar_appointments where id=p_appointment_id for update;
 if not found or a.status<>'confirmed' or a.starts_at<=now() or a.revision is distinct from p_expected_revision then
  return 'nao_se_aplica'; end if;
 if a.patient_confirmed_at is not null then return 'ja_confirmado'; end if;
 -- Sem organização no argumento: a prova da mensagem é amarrada à organização e ao paciente do compromisso.
 if p_source='mensagem' and not exists(select 1 from public.messages m where m.id=p_message_id
   and m.organization_id=a.organization_id and m.contact_id=a.contact_id and m.direction='inbound') then
  raise exception 'patient_confirm_message_not_evidence' using errcode='42501'; end if;
 -- Não mexe em starts_at nem em status: fn_appointment_stamp não incrementa a revisão.
 -- A marca local é a única porta que fn_appointment_stamp abre para estas colunas.
 perform set_config('crm.confirmacao_do_paciente','on',true);
 update public.calendar_appointments set patient_confirmed_at=now(), patient_confirmed_source=p_source,
  patient_confirmed_message_id=case when p_source='mensagem' then p_message_id end,
  patient_confirmed_user_id=case when p_source='equipe' then p_user_id end
  where id=a.id;
 perform set_config('crm.confirmacao_do_paciente','',true);
 return 'confirmado';
end; $$;
comment on function public.fn_appointment_patient_confirm(uuid,int,text,uuid,uuid) is
 'Grava "Presença confirmada" pelo paciente (migration 0441): source mensagem (resposta ao lembrete, com a mensagem inbound do paciente) ou equipe (a recepção marcou, com a pessoa). Só em compromisso confirmed, futuro e na revisão esperada. Devolve confirmado, ja_confirmado ou nao_se_aplica. Só service_role.';
revoke execute on function public.fn_appointment_patient_confirm(uuid,int,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_appointment_patient_confirm(uuid,int,text,uuid,uuid) to service_role;

comment on column public.calendar_appointments.patient_confirmed_at is
 'Quando o paciente confirmou que vem. Marca separada do status (o compromisso segue confirmed, "Agendado"). Gravada só por fn_appointment_patient_confirm; zerada por fn_appointment_stamp quando starts_at muda. Migration 0441.';
comment on column public.calendar_appointments.patient_confirmed_source is
 'Por onde veio a confirmação do paciente: mensagem (resposta ao lembrete) ou equipe (a recepção marcou, ex.: por telefone). Vocabulário em lib/agenda/tipos.ts. Migration 0441.';
comment on column public.calendar_appointments.patient_confirmed_message_id is
 'A mensagem do paciente que confirmou, quando patient_confirmed_source = mensagem. Migration 0441.';
comment on column public.calendar_appointments.patient_confirmed_user_id is
 'Quem da equipe marcou a confirmação, quando patient_confirmed_source = equipe. Migration 0441.';
comment on column public.calendar_event_types.reminder_asks_confirmation is
 'Com a chave ligada, o lembrete deste tipo termina pedindo ao paciente que responda SIM para confirmar a presença. Desligada por padrão. Migration 0441.';
