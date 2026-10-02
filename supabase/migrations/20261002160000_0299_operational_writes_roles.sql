-- Viewers cannot mutate operational data or launch business automations.
do $policies$
declare t text; minimum_role text;
begin
  foreach t in array array['messages','agent_cases','agent_inbox_items','channel_knobs'] loop
    minimum_role := case when t='channel_knobs' then 'manager' else 'agent' end;
    execute format('drop policy if exists security_role_insert on public.%I', t);
    execute format('drop policy if exists security_role_update on public.%I', t);
    execute format('drop policy if exists security_role_delete on public.%I', t);
    execute format('create policy security_role_insert on public.%I as restrictive for insert to authenticated with check (public.fn_role_at_least(organization_id,%L))',t,minimum_role);
    execute format('create policy security_role_update on public.%I as restrictive for update to authenticated using (public.fn_role_at_least(organization_id,%L)) with check (public.fn_role_at_least(organization_id,%L))',t,minimum_role,minimum_role);
    execute format('create policy security_role_delete on public.%I as restrictive for delete to authenticated using (public.fn_role_at_least(organization_id,%L))',t,minimum_role);
  end loop;
end $policies$;

-- Pacing entries are produced by the worker, never by tenant clients.
revoke insert, update, delete, truncate, references, trigger on public.pacing_ledger from public, anon, authenticated;
grant select on public.pacing_ledger to authenticated;
grant all on public.pacing_ledger to service_role;

CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  if auth.uid() is not null and p_event_type in ('message.received','appointment.outcome_confirmed') then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Eventos LGPD disparam efeito IRREVERSÍVEL (o redact anonimiza o contato) e
  -- só nascem no servidor: webhook da Nuvemshop, aprovação do pedido (que exige
  -- papel e usa a service role) e os próprios workers. Um viewer chamava esta
  -- função pela REST com `lgpd.redact_received` e anonimizava sem aprovação.
  if auth.uid() is not null and p_event_type like 'lgpd.%' then
    raise exception 'reserved_lgpd_event' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using errcode = '42501', hint = 'emit_event: caller must have agent role in the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  -- A ORIGEM E RESERVADA AO SERVIDOR — ENTAO O SERVIDOR TEM DE ESCREVE-LA.
  --
  -- O bloco acima recusa `service_origin` vindo de chamador autenticado (42501,
  -- e com razao: e o campo que AUTORIZA efeito operacional, nao payload
  -- publico). So que ninguem o escrevia no lugar dele. Efeito medido: quem move
  -- o negocio pela IA carimba a origem no servidor (`agent-stage-sync`,
  -- `appointment-stage-move`, `handoff-stage-move`) e o follow-up nasce; quem
  -- move PELO QUADRO — o operador, pela rota HTTP autenticada — emitia um
  -- evento SEM origem, `fn_service_event_origin` caia no `service_stale` final
  -- (40001), `serviceForEvent` engolia como `stale_origin` e o follow-up nunca
  -- nascia. Sem erro em lugar nenhum: o gatilho de etapa era inalcancavel pelo
  -- caminho que o produto oferece na tela.
  --
  -- O retrato e tirado AQUI, no instante da emissao, que e exatamente a
  -- semantica de procedencia que a 0223 quer: "quando este evento nasceu, o
  -- atendimento estava assim". A resolucao do contato repete a mesma regra de
  -- `fn_service_event_origin` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
      select contact_id into v_contact from public.crm_leads where organization_id=v_org_id and id=p_entity_id;
    elsif p_event_type='contact.tag_added' and p_entity_kind='contact' then
      select id into v_contact from public.contacts where organization_id=v_org_id and id=p_entity_id;
    end if;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;
revoke execute on function public.emit_event(text,text,uuid,jsonb,jsonb,uuid) from public, anon;
grant execute on function public.emit_event(text,text,uuid,jsonb,jsonb,uuid) to authenticated, service_role;
