-- 0425 — A atribuição pedida pelo PRÓPRIO turno da IA deixa de revogar esse
-- turno. O Assumir/Transferir de uma pessoa continua revogando.
--
-- Porte de melgarafael/DeskcommCRM #3953 (issue #3926; migration 9103 lá), na
-- forma do fork.
--
-- O defeito: `crm_assign_conversation` chama `fn_conversation_assign` com
-- reason 'transfer'. O INSERT em `conversation_assignment_events` dispara
-- `trg_interromper_turnos_ao_assumir` (0361), que marca `failed`
-- (`conversation_command_taken`) todo `inbound_turn`/`case_reply_turn` vivo da
-- conversa, inclusive o turno que acabou de pedir a atribuição. Daí em diante
-- `requireCurrentAutonomousTurn` recusa as escritas seguintes do turno: a
-- passagem para a pessoa (`request_human_handoff`) e a mudança de etapa morrem
-- sem rastro. A ordem das ferramentas no prompt não protege: o AI SDK roda as
-- chamadas do mesmo passo em paralelo.
--
-- Diferença do original: lá `fn_conversation_assign` ganhou um 7º parâmetro e
-- a coluna `source_job_id`. Aqui a assinatura e o corpo de
-- `fn_conversation_assign` ficam intactos (mudar a assinatura obrigaria a
-- reescrever a primeira definição no baseline e abriria janela de sobrecarga
-- no update.sh). Em vez disso:
--
--   · `fn_conversation_assign_pelo_turno` (security invoker, só service_role)
--     grava o job em `app.turno_que_atribui` com `set_config(..., true)`
--     (local à transação) e chama `fn_conversation_assign` igual;
--   · o gatilho poupa esse job, e só quando o evento não tem pessoa
--     (`changed_by` nulo = runtime). Os OUTROS turnos da conversa continuam
--     revogados; a atribuição de uma pessoa revoga todos, como antes.
--
-- Uma sessão de pessoa não consegue fabricar a marca: não executa a função
-- nova, e mesmo que pusesse a variável o evento dela tem `changed_by`.
-- Gatilho não faz HTTP. Nenhum dado reescrito.

create or replace function public.fn_interromper_turnos_ao_assumir()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_contact uuid;
  v_turno uuid;
begin
  -- Distribuir pelo rodízio não é assumir; o handoff é decisão do próprio turno.
  if new.reason not in ('claim', 'transfer') or new.to_user_id is null then return new; end if;
  -- O evento tem de corresponder ao dono real, na MESMA organização.
  select c.contact_id into v_contact from public.conversations c
   where c.organization_id = new.organization_id and c.id = new.conversation_id
     and c.assigned_to_user_id = new.to_user_id;
  if v_contact is null then return new; end if;
  -- O turno que PEDIU esta atribuição não perde o próprio comando (0425): só
  -- ele é poupado, e só quando quem atribuiu é o runtime (sem pessoa logada).
  -- A marca vem de fn_conversation_assign_pelo_turno, na mesma transação.
  if new.changed_by is null then
    v_turno := nullif(current_setting('app.turno_que_atribui', true), '')::uuid;
  end if;

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
     and j.id is distinct from v_turno
     and ((j.kind in ('inbound_turn', 'case_reply_turn') and j.status in ('pending', 'running'))
       or (j.kind = 'followup_turn' and j.status = 'running'));

  update public.job_queue j
     set status = 'failed', locked_by = null, locked_at = null,
         last_error = 'conversation_command_taken'
   where j.organization_id = new.organization_id and j.contact_id = v_contact
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and j.id is distinct from v_turno
     and j.kind in ('inbound_turn', 'case_reply_turn')
     and j.status in ('pending', 'running');
  return new;
end;
$$;
revoke execute on function public.fn_interromper_turnos_ao_assumir() from public, anon, authenticated, service_role;

-- A atribuição pedida pelo turno da IA (`crm_assign_conversation` no turno).
-- Marca o job na transação e chama a porta única de atribuição, sem mudar a
-- assinatura dela. Só o runtime (service_role) executa.
create or replace function public.fn_conversation_assign_pelo_turno(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid,
  p_enforce_expected boolean,
  p_source_job_id uuid
)
returns setof public.conversations
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.set_config('app.turno_que_atribui', coalesce(p_source_job_id::text, ''), true);
  return query select * from public.fn_conversation_assign(
    p_organization_id, p_conversation_id, p_to_user_id, p_reason, p_expected_assignee, p_enforce_expected);
  perform pg_catalog.set_config('app.turno_que_atribui', '', true);
end;
$$;
revoke execute on function public.fn_conversation_assign_pelo_turno(uuid, uuid, uuid, text, uuid, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_conversation_assign_pelo_turno(uuid, uuid, uuid, text, uuid, boolean, uuid)
  to service_role;

notify pgrst, 'reload schema';
