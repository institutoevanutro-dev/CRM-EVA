-- 0369: o contato GANHOU telefone alcança a origem do atendimento.
--
-- Porte do upstream #2861 (@webtecnica; 0670 lá, refs #2812). O gatilho de
-- automação novo `contact.phone_added` nasce do PATCH de contatos, pela chave
-- de serviço, DEPOIS de gravar o número e só na transição de sem número para
-- com número. Duas mudanças, as duas de uma linha:
--
--  1. `fn_service_event_contact` passa a resolver o contato desse tipo. Sem
--     isso o `emit_event` não carimba `service_origin`, e uma regra
--     "ganhou telefone → enviar WhatsApp" terminava em
--     `service_boundary_stale` (o mesmo defeito do aniversário, 0345).
--  2. `emit_event` reserva o tipo ao servidor, como o aniversário: forjado por
--     login, seria envio de WhatsApp em nome de um telefone que ninguém gravou.
--
-- Nenhuma regra é criada e nenhuma regra existente muda: o tipo é novo, e só
-- dispara a regra que alguém criar com ele. Trigger nenhum faz HTTP.
-- Idempotente (create or replace), sem BEGIN/COMMIT. Os grants seguem os de
-- antes: emit_event revogado de public e anon; fn_service_event_contact só da
-- service_role.

create or replace function public.fn_service_event_contact(p_org uuid,p_event_type text,p_entity_kind text,p_entity_id uuid)
returns table(contact_id uuid,suportado boolean) language plpgsql stable security definer set search_path=public as $$
begin
 if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('contact.tag_added','contact.birthday','contact.phone_added') and p_entity_kind='contact' then
   return query select (select c.id from public.contacts c where c.organization_id=p_org and c.id=p_entity_id),true;
 elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled','appointment.completed','appointment.no_show') and p_entity_kind='calendar_appointment' then
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id),true;
 else
   return query select null::uuid,false;
 end if;
end $$;
revoke all on function public.fn_service_event_contact(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_contact(uuid,text,text,uuid) to service_role;

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
  -- `ai.case_opened`/`ai.case_closed` entram pela mesma razão (0319): quem os
  -- emite é o gatilho de `agent_cases`, e um evento de caso forjado por login
  -- cria ou cancela follow-up em nome de uma decisão que ninguém tomou.
  -- `contact.birthday` entra pela 0345 (0551 no original): só o cron
  -- (`contact-birthdays`, sem sessão) o emite, e a partir desta migration ele
  -- alcança a origem e manda WhatsApp de verdade — forjado por login, seria
  -- envio em nome de um aniversário que ninguém fez.
  -- `conversation.autonomous_turn_revoked` entra pela 0361 (0594 no original):
  -- só o gatilho de Assumir/Transferir o grava, e ele tira a autorização de um
  -- turno da IA. Forjado por login, calaria a IA sem ninguém ter assumido.
  -- `contact.phone_added` entra pela 0369 (0670 no original): quem o emite é o
  -- servidor (o PATCH de contatos, com a chave de serviço, depois de gravar o
  -- número), e ele alcança a origem e manda WhatsApp.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday','contact.phone_added',
    'conversation.autonomous_turn_revoked'
  ) then
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
  -- atendimento estava assim". A resolucao do contato vem da mesma tabela de
  -- `fn_service_event_contact` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    select f.contact_id into v_contact
      from public.fn_service_event_contact(v_org_id, p_event_type, p_entity_kind, p_entity_id) f;
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
