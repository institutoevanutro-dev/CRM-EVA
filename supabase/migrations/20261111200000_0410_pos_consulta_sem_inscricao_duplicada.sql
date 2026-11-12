-- Migration 0410 : PRESENÇA NÃO ABRE INSCRIÇÃO DUPLICADA NO MESMO PÓS-CONSULTA.
--
-- Incidente de 11/11: a equipe marcou presença, de uma vez, em consultas de
-- quase quatro semanas atrás. Cada marcação abriu uma inscrição nova no fluxo
-- `appointment_attended` (0373), e a regra "presença NOVA recomeça a régua"
-- cancelava a inscrição viva da consulta anterior e começava outra no MESMO
-- fluxo: quem já tinha recebido as mensagens de 7 e 15 dias recebeu tudo de
-- novo.
--
-- `fn_appointment_recover`, no MESMO fluxo pós-consulta, passa a olhar as
-- inscrições que contam: a viva (active, waiting_reply, paused_handoff,
-- paused_manual) e a iniciada dentro de `janela_pos_consulta` (30 dias) que
-- enviou ao menos uma mensagem (`action_sent`). Encerrada sem envio — cancelada
-- antes de qualquer envio, ou concluída com todas as ações puladas por prazo
-- vencido — não chegou ao paciente e não conta. Decide a DATA DA CONSULTA:
--   * consulta desta presença NÃO mais recente que a de alguma delas (ou uma
--     delas sem consulta): nada abre. Retorno `{"result":"already_enrolled"}`,
--     sem recibo e sem aviso na Central (não é pendência), e uma linha
--     `followup_not_reopened` na linha do tempo de cada negócio do contato;
--   * MAIS recente: abre ancorada nela, e a viva (se houver) é encerrada com
--     cancel_reason próprio e evento `superseded_by_newer_appointment`; a linha
--     do tempo ganha `followup_superseded`.
-- Os tipos da linha do tempo são constantes no corpo (`c_tl_*`), espelho de
-- `ATIVIDADE_POS_CONSULTA_*` em lib/leads/activity-vocabulary.ts; a coluna é de
-- vocabulário aberto (sem CHECK), e `cancel_reason` é texto livre (sem CHECK).
-- A inscrição viva em OUTRO fluxo pós-consulta segue a 0373. Falta
-- (`appointment_no_show`) não muda.
--
-- Nenhuma tabela, coluna, constraint ou função nova: só o corpo. No baseline a
-- troca foi feita NO LUGAR, nas duas definições desta função
-- (tests/invariants/reaplicar-o-baseline-nao-abre-janela.test.ts), e o corpo
-- abaixo é cópia da última de lá
-- (tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts).


create or replace function public.fn_appointment_recover(p_org uuid,p_event uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; a public.calendar_appointments; r public.appointment_recovery_receipts;
 contact uuid; rev bigint; result text; candidates uuid[]; pointer uuid; agent uuid; version uuid; node text; boundary jsonb; enrollment uuid;
 attended boolean; v_status text; v_kind text; pinned uuid;
 -- 0410: janela em que uma inscrição anterior no MESMO fluxo pós-consulta impede outra.
 janela_pos_consulta constant interval := interval '30 days';
 -- 0410: tipos da linha do tempo (lib/leads/activity-vocabulary.ts, ATIVIDADE_POS_CONSULTA_*).
 c_tl_trocado constant text := 'followup_superseded';
 c_tl_mantido constant text := 'followup_not_reopened';
 ant_id uuid; ant_inicio timestamptz; trocada uuid; trocada_consulta uuid; trocada_no text;
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
 -- 0410: presença não abre inscrição duplicada no MESMO fluxo pós-consulta.
 -- Incidente de 11/11: presença marcada em lote em consultas antigas abriu uma
 -- segunda inscrição para quem já estava no fluxo (ou já tinha recebido as
 -- mensagens dele), e a régua inteira saiu de novo. Contam: a inscrição VIVA no
 -- mesmo fluxo e a iniciada nele dentro da janela que enviou ao menos uma
 -- mensagem (encerrada sem envio — cancelada antes, ou com as ações puladas por
 -- prazo vencido — não chegou ao paciente). Decide a DATA DA CONSULTA: se a
 -- consulta desta presença não é mais recente que a de alguma delas (ou se uma
 -- delas não tem consulta), nada abre; se é mais recente, abre e a viva (se
 -- houver) é trocada por ela, logo abaixo. Nos dois casos a linha do tempo do
 -- negócio diz o porquê. Sem recibo e sem aviso: não é pendência; o retorno
 -- `already_enrolled` fica no detalhe do consumidor do event_log.
 if result is null and attended then
  select x.id,ca.starts_at into ant_id,ant_inicio from public.followup_enrollments x
   left join public.calendar_appointments ca on ca.organization_id=p_org and ca.id=x.appointment_id
   where x.organization_id=p_org and x.contact_id=contact and x.pointer_id=candidates[1]
    and (x.status in ('active','waiting_reply','paused_handoff','paused_manual')
     or (x.started_at>now()-janela_pos_consulta
      and exists(select 1 from public.followup_enrollment_events ev
       where ev.organization_id=p_org and ev.enrollment_id=x.id and ev.event_type='action_sent')))
   order by ca.starts_at desc nulls first limit 1;
  if found and (ant_inicio is null or ant_inicio>=a.starts_at) then
   insert into public.crm_lead_activities(organization_id,lead_id,contact_id,source_module,source_id,type,actor_kind,reason,payload)
    select p_org,l.id,contact,'followup',a.id,c_tl_mantido,'system',
     'Presença confirmada numa consulta que não é mais recente que a do pós-consulta em andamento ou já enviado; nada foi aberto.',
     jsonb_build_object('appointment_id',a.id,'pointer_id',candidates[1],'enrollment_id',ant_id)
    from public.crm_leads l where l.organization_id=p_org and l.contact_id=contact
     and not exists(select 1 from public.crm_lead_activities t where t.organization_id=p_org and t.lead_id=l.id and t.type=c_tl_mantido and t.source_id=a.id);
   return jsonb_build_object('result','already_enrolled');
  end if;
  select x.id,x.appointment_id into trocada,trocada_consulta from public.followup_enrollments x
   where x.organization_id=p_org and x.contact_id=contact and x.pointer_id=candidates[1]
    and x.status in ('active','waiting_reply','paused_handoff','paused_manual') limit 1;
 end if;
 -- 0373: presença NOVA recomeça a régua pós-consulta (no MESMO fluxo, desde a
 -- 0410, só quando a consulta é mais recente: decidido no bloco acima). A inscrição viva de uma
 -- presença ANTERIOR não é "outro acompanhamento": é cancelada no mesmo bloco
 -- da inscrição nova, logo abaixo. Qualquer outro fluxo vivo continua impedindo.
 if result is null and exists(select 1 from public.followup_enrollments x where x.organization_id=p_org and x.contact_id=contact and x.status in ('active','waiting_reply','paused_handoff','paused_manual')
    and not (attended and x.appointment_id is not null and x.appointment_id<>a.id
     and exists(select 1 from public.followup_flow_pointers xp where xp.organization_id=p_org and xp.id=x.pointer_id and xp.trigger_config->>'kind'='appointment_attended'))) then result:='other_flow'; end if;
 if result is null then
  pointer:=candidates[1];
  select active_version_id into version from public.followup_flow_pointers where organization_id=p_org and id=pointer and status='active' for share;
  -- Precedência de AGENTES já canônica em resolveAgentForAutomaticTrigger.
  select agent_id into agent from public.ai_agent_versions where organization_id=p_org and status='published'
   and followup->'enabled'='true'::jsonb and followup->'flow_pointer_ids' ? pointer::text order by agent_id limit 1;
  select n->>'id' into node from public.followup_flow_versions v cross join lateral jsonb_array_elements(v.graph->'nodes') n
   where v.organization_id=p_org and v.id=version and n->>'type'='trigger';
  if version is null or agent is null or node is null then raise exception 'appointment_flow_changed' using errcode='PT409'; end if;
  -- 0377: o fluxo pode fixar o canal de envio em trigger_config.params.channel_session_id
  -- (ex.: o número pessoal do médico no pós-consulta). Vale só canal DESTA organização,
  -- não arquivado e de WhatsApp 1:1 (`fn_service_begin` cria conversa 'whatsapp').
  -- Fixado mas arquivado, de outra organização ou de outro tipo: volta ao canal da
  -- conversa da consulta, como antes da 0377 — trocar de número não pode calar o
  -- acompanhamento. Comparação por texto: trigger_config é jsonb sem CHECK.
  select s.id into pinned from public.followup_flow_pointers p
   join public.channel_sessions s on s.organization_id=p_org and s.id::text=p.trigger_config->'params'->>'channel_session_id'
   where p.organization_id=p_org and p.id=pointer and s.archived_at is null and s.provider in ('waha','meta_cloud','zernio');
  begin
   boundary:=public.fn_service_event_origin(p_org,p_event,contact,coalesce(pinned,
    (select channel_session_id from public.conversations where organization_id=p_org and id=a.conversation_id and contact_id=contact)));
  exception when serialization_failure or sqlstate 'PT409' then result:='stale'; end;
  if result is null then
   begin
    -- 0410: a viva do MESMO fluxo, de consulta mais antiga, é trocada pela nova.
    if trocada is not null then
     update public.followup_enrollments set status='cancelled',
      cancel_reason='Presença confirmada numa consulta mais recente; o acompanhamento recomeçou por ela.',
      completed_at=now(),next_eval_at=null,claimed_until=null
      where organization_id=p_org and id=trocada and status in ('active','waiting_reply','paused_handoff','paused_manual')
      returning current_node_id into trocada_no;
     insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
      values(p_org,trocada,trocada_no,'superseded_by_newer_appointment',
       jsonb_build_object('appointment_id',a.id,'previous_appointment_id',trocada_consulta),'superseded:'||a.id||':'||a.revision)
      on conflict do nothing;
    end if;
    if attended then
     update public.followup_enrollments x set status='cancelled',cancel_reason='O paciente compareceu a uma nova consulta; o acompanhamento recomeçou por ela.',
      completed_at=now(),next_eval_at=null,claimed_until=null
      where x.organization_id=p_org and x.contact_id=contact and x.status in ('active','waiting_reply','paused_handoff','paused_manual')
       and x.appointment_id is not null and x.appointment_id<>a.id
     and exists(select 1 from public.followup_flow_pointers xp where xp.organization_id=p_org and xp.id=x.pointer_id and xp.trigger_config->>'kind'='appointment_attended');
    end if;
    insert into public.followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,agent_id,current_node_id,service_boundary,
     appointment_id,appointment_revision)
    values(p_org,pointer,version,contact,(boundary->>'conversation_id')::uuid,agent,node,boundary,a.id,a.revision) returning id into enrollment;
    insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
     values(p_org,enrollment,node,'enrolled',jsonb_build_object('trigger_kind',v_kind,'appointment_id',a.id,'appointment_revision',a.revision),'appointment:'||a.id||':'||a.revision);
    if trocada is not null then
     insert into public.crm_lead_activities(organization_id,lead_id,contact_id,source_module,source_id,type,actor_kind,reason,payload)
      select p_org,l.id,contact,'followup',a.id,c_tl_trocado,'system',
       'Presença confirmada numa consulta mais recente; o pós-consulta anterior foi encerrado e recomeçou por esta.',
       jsonb_build_object('appointment_id',a.id,'previous_appointment_id',trocada_consulta,'enrollment_id',enrollment,'previous_enrollment_id',trocada)
      from public.crm_leads l where l.organization_id=p_org and l.contact_id=contact;
    end if;
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

notify pgrst, 'reload schema';
