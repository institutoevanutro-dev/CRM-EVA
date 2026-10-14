-- 0361 — Assumir a conversa interrompe o turno da IA que ainda estava na fila
-- ou rodando.
--
-- Porte de melgarafael/DeskcommCRM #2541 (@ozzure; migrations 0594 e 0615 lá,
-- juntas aqui porque o fork nunca teve a 0594) e do teste #2741
-- (@melgarafael). A parte sem banco veio no PR #231 do fork
-- (`guardServiceTools` em lib/atendimento/fronteira-server.ts), que deixou
-- documentada a janela que esta migration fecha:
--
--   1. a pessoa clica "Assumir" enquanto uma ferramenta da IA roda: o #231
--      contava isso como "a própria IA passou a vez" e as escritas seguintes do
--      MESMO turno (mover o card, marcar/cancelar horário, etiqueta) passavam;
--   2. o turno da IA que esperava na fila (agrupamento de mensagens, retry)
--      continuava `pending`; devolvida a conversa ao automático, ele rodava e
--      respondia a mensagem antiga.
--
-- O QUE MUDA, NA MESMA TRANSAÇÃO DE `fn_conversation_assign`:
--
--   · `inbound_turn` e `case_reply_turn` daquela conversa e organização, em
--     `pending` ou `running`, viram `failed` com
--     `last_error = 'conversation_command_taken'` e sem lease. Devolver ao
--     automático NÃO os traz de volta: um turno novo nasce da próxima mensagem.
--   · `followup_turn` em `running` ganha um fato terminal no `event_log`
--     (`conversation.autonomous_turn_revoked`, entidade `job`). A linha do job
--     não é tocada porque a sessão de quem clica não pode escrever em job de
--     follow-up (`fn_followup_generation_write`, 42501): o worker encerra o
--     turno sob a autoridade dele. O follow-up `pending` fica com a política do
--     próprio fluxo (`handoff_policy`, aplicada na hora do turno por
--     lib/followup/pessoa-no-comando-no-turno.ts).
--   · Todo job revogado ganha o mesmo fato, com o motivo, o tipo e o estado em
--     que estava: é o registro único que o servidor consulta
--     (`fn_autonomous_turn_revoked`) antes de cada escrita da IA.
--
-- Só `claim` e `transfer` com dono humano de fato na conversa. `routing`
-- (rodízio), `handoff` (a própria IA passando a vez), `release` e
-- `member_revoked` não revogam nada.
--
-- O QUE NÃO MUDA: mensagem já entregue ao WAHA não volta; efeito já gravado
-- não é desfeito; nenhuma chamada externa sai daqui (o gatilho só escreve em
-- duas tabelas do mesmo banco). `approved_reply`, `transactional_delivery` e
-- `operator_turn` são ordem de pessoa e seguem como estão.
--
-- Idempotente: `create or replace` em tudo e `create or replace trigger`, sem
-- `drop trigger` antes (a reaplicação do baseline não pode abrir janela). Sem
-- backfill: só age em atribuições que acontecerem depois dela.

-- O predicado ÚNICO de "este turno perdeu o comando". Exige organização, job,
-- a conversa do próprio job, tipo, entidade e estado concluído (0615 lá).
create or replace function public.fn_autonomous_turn_revoked(p_org uuid, p_job uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.job_queue j
    join public.event_log r on r.organization_id = j.organization_id and r.entity_id = j.id
    where j.organization_id = p_org and j.id = p_job
      and r.event_type = 'conversation.autonomous_turn_revoked'
      and r.entity_kind = 'job' and r.status = 'done'
      and r.payload->>'conversation_id' = j.payload->'service_boundary'->>'conversation_id'
  );
$$;
revoke all on function public.fn_autonomous_turn_revoked(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_autonomous_turn_revoked(uuid, uuid) to service_role;

create or replace function public.fn_interromper_turnos_ao_assumir()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_contact uuid;
begin
  -- Distribuir pelo rodízio não é assumir; o handoff é decisão do próprio turno.
  if new.reason not in ('claim', 'transfer') or new.to_user_id is null then return new; end if;
  -- O evento tem de corresponder ao dono real, na MESMA organização.
  select c.contact_id into v_contact from public.conversations c
   where c.organization_id = new.organization_id and c.id = new.conversation_id
     and c.assigned_to_user_id = new.to_user_id;
  if v_contact is null then return new; end if;

  -- O fato vem ANTES do update: ele guarda o estado em que o job estava.
  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
  select new.organization_id, 'conversation.autonomous_turn_revoked', 'job', j.id,
         jsonb_build_object('conversation_id', new.conversation_id, 'assignment_event_id', new.id,
                            'motivo', new.reason, 'kind', j.kind, 'status_anterior', j.status),
         'done'
    from public.job_queue j
   where j.organization_id = new.organization_id and j.contact_id = v_contact
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and ((j.kind in ('inbound_turn', 'case_reply_turn') and j.status in ('pending', 'running'))
       or (j.kind = 'followup_turn' and j.status = 'running'));

  update public.job_queue j
     set status = 'failed', locked_by = null, locked_at = null,
         last_error = 'conversation_command_taken'
   where j.organization_id = new.organization_id and j.contact_id = v_contact
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and j.kind in ('inbound_turn', 'case_reply_turn')
     and j.status in ('pending', 'running');
  return new;
end;
$$;
-- Função de gatilho: ninguém a chama por RPC.
revoke execute on function public.fn_interromper_turnos_ao_assumir() from public, anon, authenticated, service_role;

create or replace trigger trg_interromper_turnos_ao_assumir
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_interromper_turnos_ao_assumir();

-- O fato é do gatilho, nunca de um login: `emit_event` (e `fn_log_event`, que
-- delega a ele) recusa o tipo para quem tem sessão. Corpo inteiro abaixo; a
-- única mudança é a linha do tipo novo na lista reservada.
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
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday',
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
