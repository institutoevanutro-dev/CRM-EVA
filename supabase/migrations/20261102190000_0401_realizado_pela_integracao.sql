-- Migration 0401 : "REALIZADO" INFORMADO PELA INTEGRAÇÃO DO PRONTUÁRIO.
--
-- Presença era só declaração humana (0224): fn_appointment_stamp exigia sessão
-- com papel >= agent. Pedido do dono (02/11): quando o profissional finaliza a
-- consulta no prontuário, o compromisso vira "Realizado" sem alguém repetir o
-- clique na Agenda. A porta é estreita: só `completed` (falta continua humana),
-- só por fn_appointment_complete_by_integration (service_role, chamada pelo CRM
-- depois de conferir o escopo `agenda:outcome` do token), e a linha fica com
-- outcome_source_kind='integration' e outcome_user_id nulo — não finge ser pessoa.
-- Quem informou (token e nome do profissional) vai para a auditoria.
--
-- Sem coluna nova. Idempotente: create or replace + revoke/grant.
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
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
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
revoke all on function public.fn_appointment_stamp() from public,anon,authenticated;

create or replace function public.fn_appointment_complete_by_integration(p_org uuid,p_id uuid,p_revision bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r jsonb;
begin
 if auth.uid() is not null then raise exception 'appointment_integration_only' using errcode='42501'; end if;
 perform set_config('crm.realizado_pela_integracao','on',true);
 r:=public.fn_appointment_change_core(p_org,p_id,p_revision,'{"status":"completed"}'::jsonb,false,null);
 perform set_config('crm.realizado_pela_integracao','',true);
 return r;
end; $$;
comment on function public.fn_appointment_complete_by_integration(uuid,uuid,bigint) is
 'Registra "Realizado" informado pela integração do prontuário (escopo agenda:outcome, migration 0401). Só service_role; liga a marca local que fn_appointment_stamp aceita para outcome_source_kind=integration. Não remarca, não cancela, não registra falta.';
revoke execute on function public.fn_appointment_complete_by_integration(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.fn_appointment_complete_by_integration(uuid,uuid,bigint) to service_role;
