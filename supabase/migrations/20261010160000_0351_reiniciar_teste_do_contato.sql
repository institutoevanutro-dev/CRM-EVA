-- ============================================================================
-- 0351 — REINICIAR TESTE: zera o estado de IA de UM contato da lista de teste
--
-- Quem está afinando um agente em pré-go-live manda mensagem do próprio
-- telefone, e o agente responde olhando o que ficou da rodada anterior: a
-- etapa do funil, as notas, o follow-up armado, a trava de handoff. Esta função
-- devolve o contato ao zero para a próxima mensagem começar como conversa nova.
--
-- NÃO apaga nem altera: mensagens, card do funil (`crm_leads`), agendamentos,
-- auditoria, chamadas de modelo e traços. A conversa é FECHADA, não apagada: a
-- fronteira de atendimento (`service_revision`, migration 0222) é o que tira as
-- mensagens antigas do histórico que o agente lê.
--
-- A GUARDA mora no corpo, não em quem chama: sem o telefone do contato na lista
-- de teste de um canal da MESMA organização em pré-go-live, a função recusa
-- antes de qualquer escrita. A regra do telefone é a de `numeroPodeTestar`
-- (lib/ai/elegibilidade/pre-go-live.ts): igualdade, ou a grafia brasileira com e
-- sem o nono dígito. A do canal é a de `lerModoDeAcessoDaIa`: `ai_gate` em
-- `allowlist` E `ai_gate_mode` em `pre_go_live` (marcador velho com o gate limpo
-- é canal aberto, ver a migration 0251).
--
-- Toda escrita filtra por organização E contato. `create or replace`, sem DDL e
-- sem backfill; sem BEGIN/COMMIT. Nasce revogada de public, anon e
-- authenticated: só o servidor (service_role) executa.
-- ============================================================================

create or replace function public.fn_reiniciar_teste_do_contato(p_org uuid, p_contact uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel text;
  v_conversa uuid;
  v_n integer;
  v_fechadas integer := 0;
  v_contagens jsonb;
begin
  -- Mesmo mutex do atendimento: nenhum inbound abre episódio no meio do reinício.
  perform public.fn_service_lock(p_org, p_contact);

  select regexp_replace(coalesce(k.phone_number, ''), '[^0-9]', '', 'g') into v_tel
    from public.contacts k
   where k.organization_id = p_org and k.id = p_contact;

  if coalesce(v_tel, '') = '' or not exists (
    select 1
      from public.channel_sessions s
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(s.metadata -> 'ai_test_phone_numbers') = 'array'
             then s.metadata -> 'ai_test_phone_numbers' else '[]'::jsonb end
      ) as item(valor)
      cross join lateral (
        select regexp_replace(item.valor #>> '{}', '[^0-9]', '', 'g') as d
      ) as t
     where s.organization_id = p_org
       and s.metadata ->> 'ai_gate' = 'allowlist'
       and s.metadata ->> 'ai_gate_mode' = 'pre_go_live'
       and jsonb_typeof(item.valor) = 'string'
       and (item.valor #>> '{}') ~ '^\s*\+[1-9][0-9 ()-]*\s*$'
       and (
         t.d = v_tel
         or (
           left(v_tel, 4) ~ '^55[1-9][0-9]$'
           and left(t.d, 4) = left(v_tel, 4)
           and right(t.d, 8) = right(v_tel, 8)
           and right(v_tel, 8) ~ '^[6-9]'
           and (
             (length(v_tel) = 12 and length(t.d) = 13 and substr(t.d, 5, 1) = '9')
             or (length(v_tel) = 13 and length(t.d) = 12 and substr(v_tel, 5, 1) = '9')
           )
         )
       )
  ) then
    raise exception 'contato_nao_e_de_teste' using errcode = 'P0001';
  end if;

  for v_conversa in
    select c.id
      from public.conversations c
     where c.organization_id = p_org
       and c.contact_id = p_contact
       and c.status not in ('closed', 'archived')
       and not c.is_group
       and coalesce(c.group_chat_id, '') not like '%@g.us'
     order by c.id
  loop
    perform public.fn_service_status(p_org, v_conversa, 'closed', null);
    v_fechadas := v_fechadas + 1;
  end loop;
  v_contagens := jsonb_build_object('conversations_closed', v_fechadas);

  update public.conversations
     set bot_silenced_until = null,
         last_handoff_at = null,
         last_handoff_reason = null,
         snooze_until = null
   where organization_id = p_org
     and contact_id = p_contact
     and (bot_silenced_until is not null or last_handoff_at is not null
          or last_handoff_reason is not null or snooze_until is not null);
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('conversations_unlocked', v_n);

  update public.contacts
     set force_human = false
   where organization_id = p_org and id = p_contact and force_human;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('contacts_unlocked', v_n);

  delete from public.lead_notes where organization_id = p_org and contact_id = p_contact;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('lead_notes', v_n);

  delete from public.lead_state_transitions where organization_id = p_org and contact_id = p_contact;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('lead_state_transitions', v_n);

  delete from public.lead_state where organization_id = p_org and contact_id = p_contact;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('lead_state', v_n);

  delete from public.send_ledger where organization_id = p_org and contact_id = p_contact;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('send_ledger', v_n);

  update public.cron_jobs
     set enabled = false,
         cancelled_at = now(),
         cancel_reason = 'Teste reiniciado',
         updated_at = now()
   where organization_id = p_org and contact_id = p_contact and enabled;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('cron_jobs', v_n);

  -- O evento é o mesmo do cancelamento pela tela (`cancelled_manual`): quem
  -- reinicia é uma pessoa da equipe, e o dossiê do follow-up já sabe ler isso.
  with cancelados as (
    update public.followup_enrollments
       set status = 'cancelled',
           cancel_reason = 'Teste reiniciado',
           completed_at = now(),
           next_eval_at = null,
           claimed_until = null,
           updated_at = now()
     where organization_id = p_org
       and contact_id = p_contact
       and status in ('active', 'waiting_reply', 'paused_handoff', 'paused_manual')
    returning id, current_node_id
  ), eventos as (
    insert into public.followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload)
    select p_org, id, current_node_id, 'cancelled_manual', jsonb_build_object('reason', 'Teste reiniciado')
      from cancelados
    returning 1
  )
  select count(*) into v_n from cancelados;
  v_contagens := v_contagens || jsonb_build_object('followup_enrollments', v_n);

  -- O vínculo é pela conversa: `agent_cases` não tem FK para `contacts`.
  with cancelados as (
    update public.agent_cases
       set status = 'cancelled', closed_at = now(), updated_at = now()
     where organization_id = p_org
       and status in ('awaiting_human', 'awaiting_lead')
       and conversation_id in (
         select c.id from public.conversations c
          where c.organization_id = p_org and c.contact_id = p_contact
       )
    returning id
  ), eventos as (
    insert into public.agent_case_events (organization_id, case_id, kind, actor_kind, body)
    select p_org, id, 'cancelled', 'system', 'Teste reiniciado' from cancelados
    returning 1
  )
  select count(*) into v_n from cancelados;
  v_contagens := v_contagens || jsonb_build_object('agent_cases', v_n);

  update public.agent_inbox_items
     set status = 'resolved', resolved_at = now()
   where organization_id = p_org
     and kind = 'handoff'
     and ref_kind = 'contact'
     and ref_id = p_contact
     and status = 'open';
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('agent_inbox_items', v_n);

  return v_contagens;
end;
$$;

revoke execute on function public.fn_reiniciar_teste_do_contato(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_reiniciar_teste_do_contato(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
