-- Migration 0373 : PRESENÇA CONFIRMADA INICIA O ACOMPANHAMENTO PÓS-CONSULTA.
--
-- Pedido da clínica: depois que o paciente COMPARECE, mandar mensagem 7, 15,
-- 30 e 45 dias depois da consulta. "Compareceu" é o desfecho `completed`
-- registrado pela equipe (PATCH /api/v1/agenda/agendamentos ou a ferramenta
-- MCP crm_set_appointment_outcome), que passa por fn_appointment_change_core.
-- Até aqui só a FALTA (`no_show`) emitia evento; a presença não disparava nada.
--
-- O caminho é o MESMO da falta (0224), não um paralelo:
--
--   fn_appointment_change_core  emite `appointment.attended` (irmão de
--                               `appointment.outcome_confirmed`) quando o
--                               desfecho humano é `completed`, no mesmo commit.
--   followup-gatilho-presenca.v1  passa a ouvir os dois eventos e chama
--                               fn_appointment_recover.
--   fn_appointment_recover      lê o tipo do evento: `completed` +
--                               `appointment_attended` em vez de `no_show` +
--                               `appointment_no_show`. Mesmo mutex, mesmo
--                               recibo por (compromisso, revisão) — é ele que
--                               impede inscrever a mesma consulta duas vezes —,
--                               mesmo filtro de tipo de compromisso, mesmo
--                               ponteiro armado por agente publicado, mesmo
--                               aviso na Central quando o paciente já tem outro
--                               acompanhamento vivo (uma inscrição viva por
--                               contato). Diferença deliberada: presença SEM
--                               fluxo pós-consulta armado não grava recibo nem
--                               aviso — a maioria das consultas não tem
--                               acompanhamento, e um aviso por consulta seria
--                               ruído. Falta sem fluxo continua aviso.
--   fn_followup_revision e fn_appointment_enrollment_current  aceitam a origem
--                               `completed` (antes só `no_show`), senão a
--                               inscrição pós-consulta recusaria o 1º passo.
--   fn_service_event_contact    resolve o contato de `appointment.attended`.
--
-- Mudar o desfecho depois (compareceu -> faltou, remarcar, cancelar) troca a
-- revisão do compromisso, e o change_core já cancela a inscrição presa à
-- revisão anterior — a pós-consulta herda isso sem código novo.
--
-- Nenhuma tabela nova, nenhuma coluna nova, nenhuma função nova: só corpos.
-- `trigger_config` é jsonb SEM CHECK (vocabulário no Zod de
-- lib/followup/api-schemas.ts); `appointment_recovery_receipts.result` e
-- `agent_inbox_items.kind` já cobrem os valores usados.
--
-- No baseline a troca foi feita NO LUGAR, em todas as definições destas
-- funções (tests/invariants/reaplicar-o-baseline-nao-abre-janela.test.ts), e
-- os corpos abaixo são cópia das últimas de lá
-- (tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts).

create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and ((not public.fn_role_at_least(p_org,'agent') and public.fn_user_role_in_org(p_org)<>'provider') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if auth.uid() is not null and public.fn_user_role_in_org(p_org)='provider' and a.owner_user_id is distinct from auth.uid() then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='PT409'; end if;
 if p_remote and a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 update public.calendar_appointments set
  google_base_projection=case when p_remote then p_base else google_base_projection end,
  starts_at=case when p_patch?'starts_at' then (p_patch->>'starts_at')::timestamptz else starts_at end,
  ends_at=case when p_patch?'ends_at' then (p_patch->>'ends_at')::timestamptz else ends_at end,
  time_zone=coalesce(p_patch->>'time_zone',time_zone), status=coalesce(p_patch->>'status',status),
  cancelled_at=case when p_patch->>'status'='cancelled' then now() else cancelled_at end,
  cancellation_reason=case when p_patch?'cancellation_reason' then p_patch->>'cancellation_reason' else cancellation_reason end,
  notes=case when p_patch?'notes' then p_patch->>'notes' else notes end,
  guest_email=case when p_patch?'guest_email' then p_patch->>'guest_email' else guest_email end,
  outcome_message_id=case when p_patch?'outcome_message_id' then (p_patch->>'outcome_message_id')::uuid else null end,
  confirmation_next_at=case when p_patch?'confirmation_next_at' then (p_patch->>'confirmation_next_at')::timestamptz else confirmation_next_at end
 where organization_id=p_org and id=p_id returning * into a;
 if p_patch?'confirmation_next_at' and (a.confirmation_next_at<=now() or a.confirmation_next_at>now()+interval '24 hours') then raise exception 'appointment_invalid_snooze' using errcode='22023'; end if;
 update public.followup_enrollments set status='cancelled',cancel_reason='O compromisso mudou. Revise o próximo passo.',completed_at=now(),next_eval_at=null,claimed_until=null
  where organization_id=p_org and appointment_id=p_id and appointment_revision<>a.revision and status in ('active','waiting_reply','paused_handoff','paused_manual');
 update public.agent_inbox_items set status='resolved',resolved_at=now()
  where organization_id=p_org and ref_kind='appointment' and ref_id=p_id and status='open'
   and (appointment_revision<>a.revision or a.status in ('completed','no_show','cancelled') or p_patch?'confirmation_next_at');
 if contact is not null and a.status in ('no_show','completed') and a.outcome_recorded_at is not null and a.revision<>p_revision then
  -- Falta e presença confirmadas pela equipe: cada desfecho com o seu evento,
  -- os dois consumidos por fn_appointment_recover (migration 0373).
  insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
   values(p_org,case a.status when 'no_show' then 'appointment.outcome_confirmed' else 'appointment.attended' end,'appointment',p_id,jsonb_build_object('appointment_revision',a.revision,'service_origin',origin)) returning id into event_id;
 end if;
 return to_jsonb(a);
end; $$;
revoke all on function public.fn_appointment_change_core(uuid,uuid,bigint,jsonb,boolean,jsonb) from public,anon,authenticated;

create or replace function public.fn_appointment_recover(p_org uuid,p_event uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; a public.calendar_appointments; r public.appointment_recovery_receipts;
 contact uuid; rev bigint; result text; candidates uuid[]; pointer uuid; agent uuid; version uuid; node text; boundary jsonb; enrollment uuid;
 attended boolean; v_status text; v_kind text;
begin
 select * into e from public.event_log where organization_id=p_org and id=p_event and event_type in ('appointment.outcome_confirmed','appointment.attended') and entity_kind='appointment';
 if not found then raise exception 'appointment_source_event_missing' using errcode='P0002'; end if;
 -- 0373: presença confirmada (`completed`) segue o MESMO caminho da falta,
 -- com o seu gatilho (`appointment_attended`) no lugar de `appointment_no_show`.
 attended:=e.event_type='appointment.attended';
 v_status:=case when attended then 'completed' else 'no_show' end;
 v_kind:=case when attended then 'appointment_attended' else 'appointment_no_show' end;
 rev:=(e.payload->>'appointment_revision')::bigint;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=e.entity_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='PT409'; end if;
 select * into r from public.appointment_recovery_receipts where organization_id=p_org and appointment_id=a.id and appointment_revision=rev;
 if found then return to_jsonb(r); end if;
 result:=case when contact is null then 'no_contact' when a.revision<>rev or a.status<>v_status or a.outcome_recorded_at is null

  or not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized and is_merged_into is null and not is_blocked)
  then 'stale' else null end;
 if result is null then
  select array_agg(p.id) into candidates from public.followup_flow_pointers p
   where p.organization_id=p_org and p.status='active' and p.active_version_id is not null and p.trigger_config->>'kind'=v_kind
    and (coalesce(jsonb_array_length(p.trigger_config->'params'->'event_type_ids'),0)=0 or p.trigger_config->'params'->'event_type_ids' ? a.event_type_id::text)
    and exists(select 1 from public.ai_agent_versions v where v.organization_id=p_org and v.status='published'
     and v.followup->'enabled'='true'::jsonb and v.followup->'flow_pointer_ids' ? p.id::text);
  result:=case when coalesce(cardinality(candidates),0)=0 then 'not_configured' when cardinality(candidates)>1 then 'ambiguous' else null end;
 end if;
 if result is null and exists(select 1 from public.followup_enrollments where organization_id=p_org and contact_id=contact and status in ('active','waiting_reply','paused_handoff','paused_manual')) then result:='other_flow'; end if;
 if result is null then
  pointer:=candidates[1];
  select active_version_id into version from public.followup_flow_pointers where organization_id=p_org and id=pointer and status='active' for share;
  -- Precedência de AGENTES já canônica em resolveAgentForAutomaticTrigger.
  select agent_id into agent from public.ai_agent_versions where organization_id=p_org and status='published'
   and followup->'enabled'='true'::jsonb and followup->'flow_pointer_ids' ? pointer::text order by agent_id limit 1;
  select n->>'id' into node from public.followup_flow_versions v cross join lateral jsonb_array_elements(v.graph->'nodes') n
   where v.organization_id=p_org and v.id=version and n->>'type'='trigger';
  if version is null or agent is null or node is null then raise exception 'appointment_flow_changed' using errcode='PT409'; end if;
  begin
   boundary:=public.fn_service_event_origin(p_org,p_event,contact,
    (select channel_session_id from public.conversations where organization_id=p_org and id=a.conversation_id and contact_id=contact));
  exception when serialization_failure or sqlstate 'PT409' then result:='stale'; end;
  if result is null then
   begin
    insert into public.followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,agent_id,current_node_id,service_boundary,
     appointment_id,appointment_revision)
    values(p_org,pointer,version,contact,(boundary->>'conversation_id')::uuid,agent,node,boundary,a.id,a.revision) returning id into enrollment;
    insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
     values(p_org,enrollment,node,'enrolled',jsonb_build_object('trigger_kind',v_kind,'appointment_id',a.id,'appointment_revision',a.revision),'appointment:'||a.id||':'||a.revision);
    result:='started';
   exception when unique_violation then result:='other_flow'; end;
  end if;
 end if;
 -- Presença sem fluxo pós-consulta armado não é pendência: a maioria das
 -- consultas não tem acompanhamento, e um aviso ou um recibo por consulta
 -- seria ruído. Falta sem fluxo continua decisão terminal visível.
 if attended and result='not_configured' then return jsonb_build_object('result',result); end if;
 insert into public.appointment_recovery_receipts(organization_id,appointment_id,appointment_revision,source_event_id,result,pointer_id,enrollment_id)
  values(p_org,a.id,rev,p_event,result,pointer,enrollment) returning * into r;
 if result<>'started' and not exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   values(p_org,'appointment_recovery_review','warn',case when attended then 'O acompanhamento pós-consulta não foi iniciado' else 'A recuperação não foi iniciada' end,
    case when attended then case result when 'other_flow' then 'Este paciente já tem outro acompanhamento ativo. O pós-consulta não foi iniciado e não ficou aguardando vaga.'
     when 'ambiguous' then 'Mais de um fluxo pós-consulta atende a este compromisso. Deixe apenas um configurado.'
     else 'O contexto mudou. Abra o compromisso e escolha o próximo passo.' end else
    case result when 'other_flow' then 'Este contato já tem outro acompanhamento. Revise o próximo passo; nenhuma recuperação ficou aguardando vaga.'
     when 'ambiguous' then 'Mais de um fluxo atende a esta falta. Deixe apenas um configurado ou escolha manualmente o próximo passo.'
     when 'not_configured' then 'Configure um fluxo de recuperação e habilite-o em um assistente publicado. Esta falta não será iniciada retroativamente.'
     else 'O contexto mudou ou não há contato vinculado. Abra o compromisso e escolha o próximo passo.' end end,'appointment',a.id,rev)
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null do nothing;
 end if;
 return to_jsonb(r);
end; $$;
revoke all on function public.fn_appointment_recover(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_appointment_recover(uuid,uuid) to service_role;

create or replace function public.fn_followup_revision()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 -- Origem da recuperação é imutável, inclusive para quem pode editar o fluxo.
 -- Só o desaparecimento real da FK permite apagar a referência, cancelando-o.
 if old.appointment_revision is not null then
  new.appointment_revision:=old.appointment_revision;
  if new.appointment_id is null and not exists(select 1 from public.calendar_appointments where organization_id=old.organization_id and id=old.appointment_id) then
   new.status:='cancelled';new.cancel_reason:='O compromisso foi removido.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  else new.appointment_id:=old.appointment_id; end if;
  if new.contact_id is distinct from old.contact_id then
   new.status:='cancelled';new.cancel_reason:='O contato do compromisso mudou.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  end if;
 end if;
 if new.appointment_revision is not null and new.status in ('active','waiting_reply','paused_handoff','paused_manual') then
  -- P0001, não 40001: 40001 é serialization_failure e o cliente retenta para
  -- sempre. followup_stale é permanente. Medido: 6000 erros/min, CPU 100%, 24h.
  if old.status not in ('active','waiting_reply','paused_handoff','paused_manual') or not exists(
   select 1 from public.calendar_appointments a join public.appointment_recovery_receipts r
    on r.organization_id=a.organization_id and r.appointment_id=a.id and r.appointment_revision=a.revision
   where a.organization_id=new.organization_id and a.id=new.appointment_id and a.revision=new.appointment_revision
    and a.status in ('no_show','completed') and a.contact_id=new.contact_id and r.result='started' and r.invalidated_at is null
  ) then raise exception 'followup_stale' using errcode='P0001'; end if;
 end if;
 new.revision:=old.revision+1; return new;
end; $$;
revoke all on function public.fn_followup_revision() from public,anon,authenticated;

create or replace function public.fn_appointment_enrollment_current(p_org uuid,p_id uuid,p_node text default null)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.followup_enrollments e where e.organization_id=p_org and e.id=p_id
  and e.status in ('active','waiting_reply') and (p_node is null or e.current_node_id=p_node)
  and (e.appointment_revision is null or exists(select 1 from public.calendar_appointments a
   where a.organization_id=p_org and a.id=e.appointment_id and a.revision=e.appointment_revision and a.status in ('no_show','completed')
    and a.outcome_recorded_at is not null and a.contact_id=e.contact_id
    and exists(select 1 from public.appointment_recovery_receipts r where r.organization_id=p_org and r.appointment_id=a.id and r.appointment_revision=a.revision and r.result='started' and r.invalidated_at is null))));
$$;
revoke all on function public.fn_appointment_enrollment_current(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_appointment_enrollment_current(uuid,uuid,text) to service_role;

create or replace function public.fn_service_event_contact(p_org uuid,p_event_type text,p_entity_kind text,p_entity_id uuid)
returns table(contact_id uuid,suportado boolean) language plpgsql stable security definer set search_path=public as $$
begin
 if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('contact.tag_added','contact.birthday','contact.phone_added') and p_entity_kind='contact' then
   return query select (select c.id from public.contacts c where c.organization_id=p_org and c.id=p_entity_id),true;
 elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled','appointment.completed','appointment.no_show') and p_entity_kind='calendar_appointment' then
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id),true;
 elsif p_event_type='appointment.attended' and p_entity_kind='appointment' then
   -- 0373: presença confirmada pela equipe (emitida por fn_appointment_change_core).
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id and a.status='completed'),true;
 else
   return query select null::uuid,false;
 end if;
end $$;
revoke all on function public.fn_service_event_contact(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_contact(uuid,text,text,uuid) to service_role;

notify pgrst, 'reload schema';
