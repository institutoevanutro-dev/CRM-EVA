-- 20261006000200_0319_travas_no_banco_notas_casos_e_bloqueio.sql
-- 0319 — travas no banco: nota interna, casos da IA e bloqueio de contato.
--
-- Três regras que já valiam nas telas e nas rotas, mas não no banco. O PostgREST
-- fala com a tabela direto pelo JWT da sessão, então "a rota barra" não protege
-- de quem chama o banco por fora. Idempotente: `drop policy if exists` +
-- `create policy`, `create or replace function`, `drop trigger if exists`,
-- `revoke` (repetir não muda nada). Nenhum dado é tocado.

-- ════════════════════════════════════════════════════════════════════════════
-- 1 · NOTA INTERNA: editar e apagar só o autor ou o gestor
-- ════════════════════════════════════════════════════════════════════════════
-- Porte do DeskcommCRM original: d9c3afdfc (webtecnica, PR 1870) e da2b3462f
-- (melgarafael, PR 2080); lá, migration 0509.
--
-- A 0302 fez a nota seguir a visibilidade da conversa, mas a escrita ficou numa
-- policy única `for all` (`conversation_notes_write`): organização + papel
-- `agent` + ver a conversa, sem olhar QUEM escreveu. Entre quem vê a conversa,
-- qualquer atendente editava ou apagava a nota de um colega pelo PostgREST. A
-- rota de apagar (`app/api/v1/conversations/[id]/notes/[noteId]/route.ts`) já
-- exigia autor ou gestor; o banco não.
--
--   INSERT         organização + `agent` + ver a conversa + autor = a sessão
--   UPDATE/DELETE  organização + `agent` + ver a conversa E (autor OU gestor)
--
-- Policies permissivas somam por OR: sem derrubar a `for all`, ela continuaria
-- liberando quem não é o autor. As de leitura (`conversation_notes_select` e
-- `conversation_notes_select_platform_admin`, 0302) e a restritiva do segundo
-- fator (`mfa_provada`, 0301) ficam como estão.
--
-- O anexo (0303) não precisa de regra própria: o bucket `internal-media` não
-- tem policy em `storage.objects`, então sessão nenhuma lê, troca ou apaga o
-- arquivo direto. O único jeito de um colega "trocar o arquivo" era reapontar
-- `media_storage_path` da nota alheia, e isso é o UPDATE que esta seção fecha.
drop policy if exists "conversation_notes_write" on public.conversation_notes;

drop policy if exists "conversation_notes_insert" on public.conversation_notes;
create policy "conversation_notes_insert" on public.conversation_notes
  for insert
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and created_by_user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- O `with check` repete o `using`: o autor não passa a nota para outro nome, e
-- o gestor que edita a nota de um atendente mantém o autor original.
drop policy if exists "conversation_notes_update" on public.conversation_notes;
create policy "conversation_notes_update" on public.conversation_notes
  for update
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

drop policy if exists "conversation_notes_delete" on public.conversation_notes;
create policy "conversation_notes_delete" on public.conversation_notes
  for delete
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 2 · CASOS DA IA: só o servidor escreve, e cada um lê o que pode ver
-- ════════════════════════════════════════════════════════════════════════════
-- Porte do DeskcommCRM original: 51cf0c9de (lá, migration 0279) e a regra de
-- leitura de 369bda503, que lá ficou só na rota e aqui desce também ao banco.
--
-- ESCRITA. `agent_cases`, `agent_case_events` e `conversation_assignment_events`
-- eram graváveis pela sessão de qualquer membro, pelas DUAS origens:
--   (A) o GRANT: `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO
--       "authenticated"` do baseline vale para toda tabela criada depois dele,
--       e as três são de apêndice;
--   (B) a POLICY: `for all` no caso (a 0299 só tirou o somente leitura), `for
--       insert` sem papel nos eventos do caso e em `cae_insert`.
-- Um atendente reescrevia o resumo que a IA deixou para a equipe; qualquer
-- membro forjava um evento na linha do tempo do caso e um "fulano assumiu" no
-- histórico de atribuição. Fecham as duas origens: a policy sozinha faria o
-- UPDATE casar zero linhas e o PostgREST devolver sucesso; o revoke sozinho não
-- sobrevive a alguém recriar um grant.
--
-- Nenhum caminho legítimo escreve com a sessão do usuário (censo no fork, em
-- app/ lib/ hooks/ components/ workers/ scripts/):
--   · agent_cases / agent_case_events → `pg.Pool` do motor
--     (lib/agent-engine/agent/human-cases.ts; a rota de responder caso,
--     app/api/v1/ai/cases/[id]/reply, usa o mesmo pool depois de conferir papel
--     e organização, e audita) e o service role no cron case-stale-watcher;
--   · conversation_assignment_events → só dentro de `fn_conversation_assign`,
--     que é `security definer`: assumir, transferir e soltar seguem gravando;
--   · Supervisão, Central, Instagram e campanhas não tocam nas três tabelas.
-- Refaça: rg -n "agent_cases|agent_case_events|conversation_assignment_events" app lib hooks components workers scripts
--
-- LEITURA. O caso herda a visibilidade da CONVERSA dele (molde de `cae_select`,
-- 0173): o `exists` sobre `conversations` já aplica a RLS de lá, então a regra
-- é uma só. Antes era só organização, e o atendente restrito às próprias
-- conversas lia título, resumo e bloqueio de casos que não eram dele. A linha
-- do tempo herda do caso pelo mesmo mecanismo. A restritiva `mfa_provada`
-- (0301) fica como está nas três. As rotas da tela (app/api/v1/ai/cases) leem
-- com o cliente de SESSÃO para que esta regra valha nelas; o agente de IA (MCP)
-- segue com o service role e vê a fila inteira.

-- ── agent_cases ─────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.agent_cases from authenticated, anon;
drop policy if exists tenant_isolation_agent_cases_all on public.agent_cases;
drop policy if exists tenant_isolation_agent_cases_select on public.agent_cases;
create policy tenant_isolation_agent_cases_select on public.agent_cases
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
       where c.organization_id = agent_cases.organization_id
         and c.id = agent_cases.conversation_id
    )
  );

-- ── agent_case_events ───────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.agent_case_events from authenticated, anon;
drop policy if exists tenant_isolation_agent_case_events_insert on public.agent_case_events;
drop policy if exists tenant_isolation_agent_case_events_select on public.agent_case_events;
create policy tenant_isolation_agent_case_events_select on public.agent_case_events
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.agent_cases ac
       where ac.organization_id = agent_case_events.organization_id
         and ac.id = agent_case_events.case_id
    )
  );

-- ── conversation_assignment_events ──────────────────────────────────────────
revoke insert, update, delete, truncate on public.conversation_assignment_events
  from authenticated, anon;
drop policy if exists cae_insert on public.conversation_assignment_events;
-- `cae_select` (0173, já herda o escopo da conversa) fica como está.

-- ── travas de suporte: tabela só do servidor não carrega nenhuma ────────────
-- O bloco do suporte (0274 no baseline) tira as `support_write_*` de tabela que
-- a sessão não grava, mas só na reaplicação seguinte. Tirar aqui faz instalar e
-- atualizar terminarem no mesmo estado.
do $$
declare t text;
begin
  foreach t in array array['agent_cases','agent_case_events','conversation_assignment_events'] loop
    execute format('drop policy if exists support_write_insert on public.%I', t);
    execute format('drop policy if exists support_write_update on public.%I', t);
    execute format('drop policy if exists support_write_delete on public.%I', t);
  end loop;
end $$;

-- ── emit_event: os eventos de caso são do servidor ──────────────────────────
-- O corpo é o VIGENTE do fork (a última definição do baseline, bloco da 0299),
-- copiado por inteiro; a única mudança é a lista de tipos reservados. A reserva
-- sozinha não fecha a forja da LINHA do caso (quem fecha é o revoke acima): ela
-- fecha a forja do EVENTO, que `lib/followup/gatilho-caso.ts` consome.
-- A mensagem mantém o nome herdado (`reserved_message_received`), como no original.
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
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed'
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

notify pgrst, 'reload schema';
