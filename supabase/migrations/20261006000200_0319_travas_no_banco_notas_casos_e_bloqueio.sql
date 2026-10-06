-- 20261006000200_0319_travas_no_banco_notas_casos_e_bloqueio.sql
-- 0319 — travas no banco: nota interna, casos da IA e bloqueio de contato.
--
-- Três regras que já valiam nas telas e nas rotas, mas não no banco (seções 1 a
-- 3). O PostgREST fala com a tabela direto pelo JWT da sessão, então "a rota
-- barra" não protege de quem chama o banco por fora. As seções 4 a 8 fecham o que
-- a revisão do PR 128 achou em volta delas: caminhos que desfaziam as três regras
-- sem tocar no que elas guardam.
--
-- Idempotente: `drop policy if exists` + `create policy`, `create or replace
-- function`, `drop trigger if exists`, `create index if not exists`, `revoke`
-- (repetir não muda nada). Dois dados são tocados, os dois na seção 8 e os dois
-- CÓPIAS do título de um caso: o corpo dos avisos "caso parado" e
-- `demandas.assunto`. O título continua onde sempre esteve, em `agent_cases`.

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

-- O `with check` repete o `using`: o autor não passa a nota para outro nome.
-- Para o GESTOR o `with check` aceita qualquer autor (ele pode editar nota
-- alheia); quem impede que ele troque o autor é a trava de autoria da seção 7.
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
-- LEITURA. O caso herda a visibilidade da CONVERSA dele: a regra é a da tela
-- (`fn_can_view_conversation`), perguntada por organização e não por linha (ver
-- `fn_alcance_das_conversas` abaixo, e por quê). Antes era só organização, e o
-- atendente restrito às próprias conversas lia título, resumo e bloqueio de
-- casos que não eram dele. A linha do tempo herda do caso (`exists` sobre
-- `agent_cases`, que aplica a RLS de lá). A restritiva `mfa_provada` (0301) fica
-- como está nas três. As rotas da tela (app/api/v1/ai/cases) leem com o cliente
-- de SESSÃO para que esta regra valha nelas; o agente de IA (MCP) segue com o
-- service role e vê a fila inteira.

-- ── agent_cases ─────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.agent_cases from authenticated, anon;
drop policy if exists tenant_isolation_agent_cases_all on public.agent_cases;
drop policy if exists tenant_isolation_agent_cases_select on public.agent_cases;

-- A REGRA PERGUNTADA POR ORGANIZAÇÃO, NÃO POR CASO (revisão do PR 128, medido).
-- A visibilidade da conversa é `fn_can_view_conversation` (`security definer`,
-- não dá para embutir), que custa décimos de milissegundo por chamada. Pendurar
-- a policy do caso numa leitura de `conversations` chama a função uma vez por
-- caso VISITADO, e quem vê pouco faz o Postgres visitar a organização inteira.
-- (A forma anterior, `exists`, era pior ainda para todo mundo: 16,8 s medidos.)
-- Medido em Postgres 15 com 20.000 casos concluídos, página de 201, no mesmo
-- banco e na mesma máquina (carregada por outras suítes):
--                                      pergunta por caso   por organização
--   atendente novo em "Só os seus" ...... 27,1 s              0,14 s
--   atendente no modo padrão ............ 1,0 s               0,74 s
--   administrador ....................... 0,66 s              0,50 s
-- Acima do teto de 8 s do papel `authenticated` a aba respondia "Falha ao
-- carregar os casos". O que sobra para quem vê muito é a leitura da conversa
-- de cada caso DEVOLVIDO (o contato embutido, que a RLS de `conversations`
-- confere): por isso a lista de concluídos vem em páginas.
--
-- A regra só olha do dono da conversa três coisas: não tem dono, é a própria
-- sessão, é outra pessoa. Então três perguntas à MESMA função, por organização,
-- descrevem a regra inteira para aquela sessão — e a regra continua tendo uma
-- fonte só. Se um dia `fn_can_view_conversation` passar a olhar QUEM é o dono
-- (equipe, por exemplo), estas três perguntas deixam de bastar, e quem avisa é
-- o oráculo de tests/invariants/casos-concluidos-leitura-limitada.test.ts, que
-- compara a RLS com a função chamada conversa a conversa, papel por papel.
create or replace function public.fn_alcance_das_conversas()
returns table (organization_id uuid, sem_dono boolean, suas boolean, de_outros boolean)
language sql
stable
set search_path = public
as $$
  select o.id,
         coalesce(public.fn_can_view_conversation(o.id, null), false),
         coalesce(public.fn_can_view_conversation(o.id, auth.uid()), false),
         -- Um dono qualquer que não é a sessão: nenhum usuário tem o uuid nulo.
         coalesce(public.fn_can_view_conversation(o.id, '00000000-0000-0000-0000-000000000000'::uuid), false)
    from (select distinct u.id from public.fn_user_org_ids() as u(id)) as o
$$;
revoke execute on function public.fn_alcance_das_conversas() from public, anon;
grant execute on function public.fn_alcance_das_conversas() to authenticated;

-- As conversas que a sessão vê nas organizações em que ela NÃO vê todas. Lê
-- `conversations` como dono (`security definer`) para não pagar a RLS de lá por
-- conversa; quem decide o que entra é o alcance acima, isto é, a mesma função.
-- O índice `(organization_id, assigned_to_user_id, assigned_at)` responde às
-- duas perguntas que importam ("as minhas", "as sem dono").
create or replace function public.fn_conversas_ao_alcance()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
    from public.fn_alcance_das_conversas() as a
    join public.conversations c on c.organization_id = a.organization_id
   where not (a.sem_dono and a.suas and a.de_outros)
     and (   (a.suas and c.assigned_to_user_id = auth.uid())
          or (a.sem_dono and c.assigned_to_user_id is null)
          or (a.de_outros and c.assigned_to_user_id <> auth.uid()))
$$;
revoke execute on function public.fn_conversas_ao_alcance() from public, anon;
grant execute on function public.fn_conversas_ao_alcance() to authenticated;

-- As duas subconsultas não dependem da linha: o Postgres monta cada uma UMA vez
-- por consulta e confere o caso contra ela. Quem vê todas as conversas da
-- organização (gestor, administrador, somente leitura, ou o modo "Todos veem
-- tudo") resolve na primeira e a segunda nem é montada.
create policy tenant_isolation_agent_cases_select on public.agent_cases
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and (
      organization_id in (
        select a.organization_id from public.fn_alcance_das_conversas() as a
         where a.sem_dono and a.suas and a.de_outros
      )
      or conversation_id in (select public.fn_conversas_ao_alcance())
    )
  );

-- A lista de concluídos é lida do mais recente para trás, com limite
-- (app/api/v1/ai/cases/route.ts). Sem este índice o Postgres confere a
-- visibilidade de todos os casos da organização antes de ordenar.
create index if not exists agent_cases_org_abertura_idx
  on public.agent_cases (organization_id, opened_at desc);

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

-- ════════════════════════════════════════════════════════════════════════════
-- 3 · BLOQUEIO DO CONTATO: só o servidor muda
-- ════════════════════════════════════════════════════════════════════════════
-- Correção própria do fork (pendência da revisão do Pacote 1, PR 125).
--
-- `contacts.is_blocked`, `blocked_reason` e `blocked_at` são o pedido de "parem
-- de me escrever". Quem grava é a ingestão, quando o paciente pede
-- (lib/channels/pos-entrada.ts, que audita `contact.blocked`), e quem desfaz é
-- a rota de desbloquear (app/api/v1/contacts/[id]/unblock: só administrador,
-- segundo fator provado, `contact.unblocked` na auditoria). As duas usam o
-- service role — são os DOIS únicos escritores no código (censo:
-- rg -n "is_blocked|blocked_reason|blocked_at" app lib workers scripts).
--
-- Só que as três colunas eram graváveis pela sessão: `contacts_update` deixa o
-- `agent` editar a ficha, e nada separava o bloqueio dos outros campos. Um
-- atendente desbloqueava (ou bloqueava) um contato pelo PostgREST, sem papel de
-- administrador e sem linha na auditoria.
--
-- TRIGGER e não grant de coluna, pelo mesmo motivo da 0262
-- (`fn_colunas_de_cliente_sao_do_sistema`): seria `revoke update on contacts` +
-- `grant update (<todas as outras>)`, o `GRANT ALL ON TABLE contacts` do corpo
-- do baseline devolveria o privilégio a cada `update.sh`, e toda coluna nova de
-- `contacts` nasceria não-gravável em silêncio.
--
-- Quem é barrado é a SESSÃO, por dois sinais somados: `auth.uid()` preenchido
-- (o JWT de um usuário, que continua valendo dentro de função `security
-- definer`) ou o papel `authenticated`/`anon`. O service role (PostgREST com a
-- service key: sem `sub`, papel `service_role`), o `pg.Pool` do motor e as
-- migrations passam. Erro 42501 com o nome da regra, e não "zero linhas": o
-- PostgREST devolveria sucesso num UPDATE que não pegou.
--
-- UMA exceção, e só para APERTAR: uma função do banco que roda em nome de uma
-- sessão (o papel é o dono da função, o JWT continua lá) pode levar um contato
-- de livre para bloqueado. É o que a junção de contatos faz na seção 6, quando
-- um dos juntados pediu para parar. Soltar o bloqueio, ou mexer no motivo e na
-- data de quem já está bloqueado, continua sendo só do servidor; e a escrita
-- DIRETA da sessão na tabela não bloqueia nem desbloqueia.
create or replace function public.fn_bloqueio_do_contato_so_o_servidor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_direto boolean := current_user in ('authenticated', 'anon');
begin
  if auth.uid() is not null or v_direto then
    if tg_op = 'INSERT' then
      if new.is_blocked is true or new.blocked_reason is not null or new.blocked_at is not null then
        raise exception 'bloqueio_do_contato_so_o_servidor' using errcode = '42501';
      end if;
    elsif new.is_blocked is distinct from old.is_blocked
       or new.blocked_reason is distinct from old.blocked_reason
       or new.blocked_at is distinct from old.blocked_at then
      if v_direto or not (old.is_blocked is false and new.is_blocked is true) then
        raise exception 'bloqueio_do_contato_so_o_servidor' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

comment on function public.fn_bloqueio_do_contato_so_o_servidor() is
  'Guarda de contacts (migration 0319): sessão nenhuma muda is_blocked, blocked_reason ou blocked_at '
  '(42501 bloqueio_do_contato_so_o_servidor), nem cria contato já bloqueado; o service role, o motor e as '
  'migrations passam. Bloquear é da ingestão (pedido de parar) e desbloquear é da rota do administrador, '
  'as duas auditadas. Única exceção: função do banco em nome de uma sessão pode APERTAR (livre -> bloqueado), '
  'que é a junção de contatos levando o bloqueio adiante. Provado em '
  'tests/invariants/bloqueio-do-contato-so-o-servidor.test.ts e bloqueio-acompanha-o-telefone.test.ts.';

-- Função de trigger não exige EXECUTE de quem dispara a escrita, então ninguém
-- precisa de grant. Revogadas as duas origens (o grant a PUBLIC e o grant direto
-- do `alter default privileges`).
revoke execute on function public.fn_bloqueio_do_contato_so_o_servidor() from public, anon, authenticated;

-- UPDATE sem lista de colunas, com a WHEN comparando VALORES: `update of`
-- dispararia quando a coluna é só mencionada (um cliente que devolve a linha
-- inteira), e o caso comum — nenhuma das três mudou — nem chama a função.
drop trigger if exists trg_contato_bloqueio_so_o_servidor_update on public.contacts;
create trigger trg_contato_bloqueio_so_o_servidor_update
  before update on public.contacts
  for each row
  when (old.is_blocked is distinct from new.is_blocked
     or old.blocked_reason is distinct from new.blocked_reason
     or old.blocked_at is distinct from new.blocked_at)
  execute function public.fn_bloqueio_do_contato_so_o_servidor();

drop trigger if exists trg_contato_bloqueio_so_o_servidor_insert on public.contacts;
create trigger trg_contato_bloqueio_so_o_servidor_insert
  before insert on public.contacts
  for each row
  when (new.is_blocked is true or new.blocked_reason is not null or new.blocked_at is not null)
  execute function public.fn_bloqueio_do_contato_so_o_servidor();

-- ════════════════════════════════════════════════════════════════════════════
-- 4 · APAGAR A CONVERSA: do gestor, como apagar o contato
-- ════════════════════════════════════════════════════════════════════════════
-- Revisão do PR 128. As seções 1 e 2 não valiam para o APAGAR:
-- `conversations_agent_delete` liberava o DELETE da conversa a qualquer
-- atendente, e `conversation_notes`, `agent_cases` (e por ele
-- `agent_case_events`) e `conversation_assignment_events` pendem dela com `on
-- delete cascade`. A cascata de FK roda como dono da tabela filha: ignora as
-- policies da nota e o revoke das três tabelas do caso. Um atendente apagava a
-- conversa pelo PostgREST e levava a nota do colega, o caso da IA e o histórico
-- de atribuição, sem linha na auditoria.
--
-- O único caminho do produto que apaga conversa com a sessão é a exclusão do
-- contato (app/api/v1/contacts/_handler.ts), que exige `manager` na rota e na
-- RLS de `contacts` desde a 0289. A conversa passa a ter o mesmo piso, com a
-- mesma forma da `contacts_delete`.
--
-- `messages_delete` fica como está: o envio do atendente apaga o eco do próprio
-- envio com a sessão (`removerEcoDoProprioEnvio`, app/api/v1/messages/_handler.ts).
drop policy if exists "conversations_agent_delete" on public.conversations;
drop policy if exists "conversations_delete" on public.conversations;
create policy "conversations_delete" on public.conversations
  for delete using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 5 · ATRIBUIR A CONVERSA: só quem a vê
-- ════════════════════════════════════════════════════════════════════════════
-- Revisão do PR 128. `fn_conversation_assign` é `security definer`, executável
-- por `authenticated`, e só conferia o papel. A seção 2 pendurou a leitura do
-- caso, da linha do tempo e da nota na visibilidade da conversa; a função era a
-- porta dos fundos: o atendente chamava o RPC com a conversa de um colega,
-- virava o dono e passava a ler tudo.
--
-- O corpo é o VIGENTE do fork (a última definição do baseline, bloco do
-- roteamento por canal), copiado por inteiro; a única mudança é o bloco marcado
-- (0319). Assumir, transferir, soltar e pausar a IA pela tela agem sobre
-- conversa que quem clica está vendo, então nada muda para elas; a transferência
-- continua imediata e sem aceite (G1-06d), e quem fez fica em `changed_by`.
CREATE OR REPLACE FUNCTION public.fn_conversation_assign(p_organization_id uuid, p_conversation_id uuid, p_to_user_id uuid, p_reason text, p_expected_assignee uuid DEFAULT NULL::uuid, p_enforce_expected boolean DEFAULT false)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for no key update;

  if not found then
    return;
  end if;

  -- (0319) QUEM CHAMA PELA SESSÃO TEM DE VER A CONVERSA COMO ELA ESTÁ. A regra é
  -- a mesma da tela (`conversations_select`): o dono atual é o que decide. Zero
  -- linhas, igual a "conversa não encontrada": a função não confirma a
  -- existência dela para quem não a enxerga. O servidor (roteador, MCP, motor),
  -- sem `auth.uid()`, não passa por esta pergunta.
  if auth.uid() is not null
     and not public.fn_can_view_conversation(p_organization_id, v_from) then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$function$;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public, anon;
grant execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 6 · O BLOQUEIO ACOMPANHA A PESSOA: identidade e junção de contatos
-- ════════════════════════════════════════════════════════════════════════════
-- Revisão do PR 128. A seção 3 guarda as três colunas do bloqueio, mas o
-- bloqueio é da LINHA do contato, e o que liga a linha à pessoa é a identidade:
-- `phone_number`, o `waha_lid` (em `source_metadata`, de onde saem as colunas
-- geradas `wa_identity` e `wa_lid`) e `is_merged_into` (`fn_upsert_wa_contact` e
-- os índices únicos só olham contato com `is_merged_into is null`). Dois
-- caminhos desfaziam o EFEITO do bloqueio sem tocar nas três colunas:
--   (a) o atendente trocava telefone, lid ou `is_merged_into` do bloqueado pelo
--       PostgREST; a próxima mensagem do paciente criava um contato novo, livre;
--   (b) o gestor juntava o bloqueado (secundário) a uma duplicata livre:
--       `fn_mesclar_contatos` passava telefone e lid adiante e não o bloqueio.
--
-- (a) GUARDA DE IDENTIDADE. Num contato bloqueado, a escrita DIRETA da sessão
-- não muda telefone, lid nem `is_merged_into`. O sinal é só o papel
-- (`authenticated`/`anon`), sem `auth.uid()`: a junção (seção abaixo) e a
-- anonimização são funções do banco em nome de uma sessão e precisam gravar a
-- lápide e limpar a ficha do bloqueado. A ingestão (service role) também passa:
-- é ela que promove o telefone e grava o lid. A rota de editar contato devolve
-- 409 com a explicação antes de chegar aqui (app/api/v1/contacts/_handler.ts).
create or replace function public.fn_contato_bloqueado_guarda_a_identidade()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'contato_bloqueado_identidade_so_o_servidor' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.fn_contato_bloqueado_guarda_a_identidade() is
  'Guarda de contacts (migration 0319): num contato bloqueado, a escrita direta da sessão não muda '
  'phone_number, source_metadata.waha_lid nem is_merged_into (42501 contato_bloqueado_identidade_so_o_servidor). '
  'Sem ela o bloqueio se desfazia soltando o telefone da ficha. Ingestão, junção e anonimização passam. '
  'Provado em tests/invariants/bloqueio-acompanha-o-telefone.test.ts.';

revoke execute on function public.fn_contato_bloqueado_guarda_a_identidade() from public, anon, authenticated;

-- A WHEN compara VALORES e só olha quem já está bloqueado: o caso comum (contato
-- livre, ou bloqueado com outro campo mudando) nem chama a função. `wa_lid` é
-- coluna gerada e ainda não tem o valor novo num gatilho BEFORE, por isso a
-- comparação é sobre a origem dela.
drop trigger if exists trg_contato_bloqueado_guarda_a_identidade on public.contacts;
create trigger trg_contato_bloqueado_guarda_a_identidade
  before update on public.contacts
  for each row
  when (old.is_blocked
    and (old.phone_number is distinct from new.phone_number
      or old.is_merged_into is distinct from new.is_merged_into
      or (old.source_metadata ->> 'waha_lid') is distinct from (new.source_metadata ->> 'waha_lid')))
  execute function public.fn_contato_bloqueado_guarda_a_identidade();

-- (b) A JUNÇÃO LEVA O BLOQUEIO. O corpo é o VIGENTE do fork (a última definição
-- do baseline, bloco da 0262), copiado por inteiro; as mudanças são as quatro
-- marcadas: as variáveis, o passo 3b, as três colunas no passo 6 e a chave
-- `bloqueio_herdado` no retorno (a rota a leva para a auditoria). CPF e
-- `consent` continuam não herdados, pelo motivo escrito no passo 6; o bloqueio é
-- o contrário deles: herdar é a falha fechada.
CREATE OR REPLACE FUNCTION public.fn_mesclar_contatos(p_organization_id uuid, p_contato_principal uuid, p_contatos_secundarios uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal public.contacts%rowtype;
  v_esperado integer;
  v_achado integer;
  v_alvo record;
  v_linha record;
  v_movidas integer;
  v_pulados integer;
  v_repontado jsonb := '{}'::jsonb;
  v_nao_repontado jsonb := '{}'::jsonb;
  v_nome text;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_tags text[];
  v_leads integer := 0;
  v_service_contact uuid;
  v_bloqueado boolean;
  v_bloqueio_motivo text;
  v_bloqueio_em timestamptz;
  v_herdou_bloqueio boolean := false;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- 1 · Autorização. Fundir é destrutivo na prática: `manager`, o mesmo piso das
  --     policies de `merge_queue`. Sessão de service role (auth.uid() nulo) não
  --     passa por aqui — quem resolve a org nesse caminho é a rota, de fonte
  --     confiável, nunca do body.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_contato_principal is null
     or p_contatos_secundarios is null
     or cardinality(p_contatos_secundarios) = 0
     or p_contato_principal = any(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'selecao_de_mesclagem_invalida';
  end if;

  select count(distinct id)::integer into v_esperado
    from unnest(p_contatos_secundarios) as ids(id);
  if v_esperado <> cardinality(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'secundario_repetido';
  end if;

  -- A TRAVA DA REGRA "CLIENTES PELA AGENDA" (migration 0262), ANTES DE TODA
  -- OUTRA. O passo 5 reponta `calendar_appointments.contact_id`, e o trigger
  -- desse repontamento pede `pg_advisory_xact_lock_shared(org, 262)` — só que
  -- a esta altura a fusão já segura os contatos (passos 2 e 3).
  -- `fn_definir_cliente_pela_agenda` pega a mesma trava EXCLUSIVA e depois
  -- trava contato por contato. Medido com duas sessões, sem esta linha: a fusão
  -- morria em `deadlock detected` e a rota devolvia 500. Aqui a ordem fica a
  -- mesma das duas funções — a organização primeiro, os contatos depois. Duas
  -- fusões, ou uma fusão e uma marcação, pegam a versão compartilhada e não se
  -- esperam.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(p_organization_id::text, 262));

  -- Mesmo mutex dos atendimentos, ANTES de qualquer row lock.
  for v_service_contact in select distinct id from unnest(array[p_contato_principal]||p_contatos_secundarios) ids(id) order by id loop
    perform public.fn_service_lock(p_organization_id,v_service_contact);
  end loop;
  perform 1 from public.conversations where organization_id=p_organization_id
    and contact_id=any(array[p_contato_principal]||p_contatos_secundarios) order by id for no key update;

  -- Conversa colidente NÃO aborta a fusão. Duas conversas no mesmo
  -- `channel_session_id` é exatamente COMO a duplicata de WhatsApp nasce (dois
  -- cadastros, dois números, o mesmo número de atendimento), então recusar aqui
  -- fecharia o caminho dominante do recurso — medido: o caso ordinário do
  -- `tests/e2e/juntar-contatos-duplicados.spec.ts` virava 409.
  -- Quem trata a colisão é o passo 5: `uniq_conversations_1to1_per_contact_session`
  -- levanta unique_violation, o repontamento cai para linha a linha, a conversa
  -- que não coube FICA na lápide e sai contada em `nao_repontado` — que a rota
  -- devolve e a tela anuncia ("N registro(s) continuaram no cadastro antigo").
  -- Mensagem não se perde: `messages.contact_id` não tem índice único por
  -- contato e passa inteira para o vencedor.

  -- 2 · O principal existe, é desta org, está vivo — e trava até o fim.
  select * into v_principal from public.contacts
   where id = p_contato_principal
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_principal_indisponivel';
  end if;

  -- 3 · Os secundários também. `is_anonymized = false` não é zelo: L-04 é
  --     irreversível, e reencaixar a linha anonimizada num contato ativo a
  --     traria de volta ao atendimento pela porta dos fundos.
  perform 1 from public.contacts
   where id = any(p_contatos_secundarios)
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  get diagnostics v_achado = row_count;
  if v_achado <> v_esperado then
    raise exception using errcode = 'P0002', message = 'contato_secundario_indisponivel';
  end if;

  -- 3b · (0319) O BLOQUEIO ACOMPANHA A PESSOA. Se algum dos juntados pediu para
  --      parar e o principal está livre, o principal sai bloqueado, com o motivo
  --      e a data de quem pediu (o pedido mais antigo, se houver mais de um).
  --      Sem isto o passo 6 passava o telefone e o WhatsApp do bloqueado a uma
  --      ficha livre, e o pedido de parar se desfazia sem administrador, sem
  --      segundo fator e sem `contact.unblocked` na auditoria. Lido AQUI, antes
  --      da lápide, com as linhas já travadas pelo passo 3.
  select true, c.blocked_reason, c.blocked_at
    into v_bloqueado, v_bloqueio_motivo, v_bloqueio_em
    from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.organization_id = p_organization_id
     and c.is_blocked
   order by c.blocked_at nulls last, c.id
   limit 1;
  v_herdou_bloqueio := coalesce(v_bloqueado, false) and not v_principal.is_blocked;

  -- 4 · A LÁPIDE VEM ANTES de tudo. É ela que solta telefone/e-mail/CPF dos
  --     índices únicos parciais para o vencedor poder herdá-los no passo 6.
  update public.contacts
     set is_merged_into = p_contato_principal,
         merged_at = now(),
         updated_at = now()
   where organization_id = p_organization_id
     and id = any(p_contatos_secundarios);

  -- Cadeia: quem já tinha sido mesclado NUM dos secundários passa a apontar para
  -- o vencedor. Sem isto, `is_merged_into` vira uma corrente que a leitura teria
  -- de percorrer, e ninguém percorre.
  update public.contacts
     set is_merged_into = p_contato_principal
   where organization_id = p_organization_id
     and is_merged_into = any(p_contatos_secundarios);

  -- 5 · Reponta TODO ponteiro para os perdedores. A lista sai do catálogo; o
  --     polimórfico entra à mão porque catálogo nenhum o conhece.
  for v_alvo in
    select n.nspname as esquema, c.relname as tabela, a.attname as coluna, ''::text as filtro
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and array_length(co.conkey, 1) = 1
       and c.relkind = 'r'
       and n.nspname = 'public'
    union all
    select 'public', 'crm_lead_links', 'target_id', ' and target_kind = ''contact'''
     where to_regclass('public.crm_lead_links') is not null
    order by 2, 3
  loop
    v_pulados := 0;
    begin
      execute format(
        'update %I.%I set %I = $1 where %I = any($2)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
      ) using p_contato_principal, p_contatos_secundarios;
      get diagnostics v_movidas = row_count;
    exception when unique_violation or exclusion_violation then
      -- Colisão REAL e esperada: `uniq_job_queue_one_running_per_contact` deixa
      -- um job 'running' por contato, e os dois lados podem ter um. Em vez de
      -- abortar a fusão inteira por causa de estado efêmero de runtime, reponta
      -- linha a linha e conta quem ficou. Quem fica NÃO vira FK órfã — continua
      -- apontando para a lápide, que existe.
      v_movidas := 0;
      for v_linha in execute format(
        'select ctid as tid from %I.%I where %I = any($1)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
      ) using p_contatos_secundarios
      loop
        begin
          execute format(
            'update %I.%I set %I = $1 where ctid = $2',
            v_alvo.esquema, v_alvo.tabela, v_alvo.coluna
          ) using p_contato_principal, v_linha.tid;
          v_movidas := v_movidas + 1;
        exception when unique_violation or exclusion_violation then
          v_pulados := v_pulados + 1;
        end;
      end loop;
    end;

    if v_movidas > 0 then
      v_repontado := v_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_movidas);
    end if;
    if v_pulados > 0 then
      v_nao_repontado := v_nao_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_pulados);
    end if;
  end loop;

  -- 6 · O principal MANDA; o que ele não tem, vem dos perdedores. Nunca o
  --     contrário: sobrescrever o que o atendente digitou seria fusão com
  --     surpresa, e fusão não tem desfazer.
  select c.name into v_nome from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.name is not null
   order by c.created_at, c.id limit 1;
  select c.display_name into v_apelido from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.display_name is not null
   order by c.created_at, c.id limit 1;
  select c.birthdate into v_nascimento from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.birthdate is not null
   order by c.created_at, c.id limit 1;
  select c.email into v_email from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.email is not null
   order by c.created_at, c.id limit 1;
  select c.phone_number into v_telefone from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.phone_number is not null
   order by c.created_at, c.id limit 1;
  -- `wa_identity`/`wa_lid` são GERADAS: o que se herda é a origem delas. Sem
  -- isto o WhatsApp do perdedor fica órfão — `fn_upsert_wa_contact` filtra
  -- `is_merged_into is null`, não acharia mais ninguém e criaria um contato
  -- novo na mensagem seguinte, refazendo a duplicata que acabou de ser desfeita.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by c.created_at, c.id limit 1;

  -- Guardas de unicidade. A lápide já tirou os perdedores dos índices parciais,
  -- então o que sobrar aqui é conflito com um TERCEIRO contato vivo — e nesse
  -- caso o vencedor simplesmente não herda o campo. Falhar a fusão inteira por
  -- causa de um e-mail seria perder o repontamento que já valeu a pena.
  if v_email is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.email_normalized = lower(btrim(v_email))
  ) then v_email := null; end if;
  if v_telefone is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number = v_telefone
  ) then v_telefone := null; end if;
  if v_lid is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) then v_lid := null; end if;

  select coalesce(array_agg(distinct t), '{}'::text[]) into v_tags
    from (
      select unnest(c.tags) as t from public.contacts c
       where c.organization_id = p_organization_id
         and (c.id = p_contato_principal or c.id = any(p_contatos_secundarios))
    ) as todas;

  -- CPF e `consent` NÃO são herdados, de propósito. CPF é um PAR
  -- (`cpf_encrypted` + `cpf_hash`) preso por check constraint e criptografado
  -- com a chave da instalação — mover metade quebra a linha. `consent` é
  -- registro legal do que AQUELA pessoa autorizou; herdar um "granted_at" de
  -- outro cadastro fabricaria consentimento. Falha fechada nos dois.
  update public.contacts set
    name = coalesce(name, v_nome),
    display_name = coalesce(display_name, v_apelido),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    -- (0319) passo 3b: só APERTA. Principal já bloqueado fica como estava.
    is_blocked = is_blocked or v_herdou_bloqueio,
    blocked_reason = case when v_herdou_bloqueio then v_bloqueio_motivo else blocked_reason end,
    blocked_at = case when v_herdou_bloqueio then coalesce(v_bloqueio_em, now()) else blocked_at end,
    tags = v_tags,
    last_activity_at = greatest(
      last_activity_at,
      (select max(c.last_activity_at) from public.contacts c
        where c.id = any(p_contatos_secundarios))
    ),
    source_metadata = (
      case when source_metadata->>'waha_lid' is null and v_lid is not null
        then source_metadata || jsonb_build_object('waha_lid', v_lid)
        else source_metadata end
    )
      - case when coalesce(phone_number, v_telefone) is not null
             then 'telefone_em_conflito' else '' end
      || jsonb_build_object(
           'mesclado_de',
           coalesce(source_metadata->'mesclado_de', '[]'::jsonb)
             || to_jsonb(p_contatos_secundarios),
           'mesclado_em', to_jsonb(now())
         ),
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 7 · A fusão aparece na timeline de cada negócio que o vencedor passou a ter.
  --     `crm_lead_activities.lead_id` é NOT NULL — contato sem negócio nenhum
  --     não tem onde escrever, e para esse caso quem guarda o rastro é o
  --     `api_audit_log` que a rota emite, sempre.
  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type,
     payload, metadata, performed_at, performed_by_user_id)
  select p_organization_id, l.id, p_contato_principal, 'crm', p_contato_principal,
         'contacts_merged',
         jsonb_build_object(
           'contatos_mesclados', to_jsonb(p_contatos_secundarios),
           'repontado', v_repontado,
           'nao_repontado', v_nao_repontado
         ),
         '{}'::jsonb, now(), auth.uid()
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contato_principal;
  get diagnostics v_leads = row_count;

  return jsonb_build_object(
    'contato_id', p_contato_principal,
    'contatos_mesclados', to_jsonb(p_contatos_secundarios),
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads,
    'bloqueio_herdado', v_herdou_bloqueio
  );
end;
$function$;
revoke execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 7 · NOTA INTERNA: quem assina e o que se anexa é o banco
-- ════════════════════════════════════════════════════════════════════════════
-- Revisão do PR 128. A seção 1 amarra `created_by_user_id = auth.uid()` no
-- INSERT, mas o autor que a TELA mostra é `created_by_name`
-- (components/inbox/NoteCard.tsx), o mesmo campo que vai para o relatório de LGPD
-- e para a continuidade que a IA lê (lib/escalacao/continuidade.ts). Era texto
-- livre: o atendente assinava a própria nota como "Dra. Maria (gestora)", com
-- data antiga, e o gestor passava a nota de um atendente para o nome de outro
-- (o `with check` do UPDATE aceita qualquer autor quando quem grava é gestor).
--
-- Para toda escrita com sessão:
--   INSERT  o nome é o de `auth.users` (o mesmo `full_name` que a rota manda) e
--           a data é a do servidor, seja o que for que o cliente enviou;
--   UPDATE  autor, nome do autor e data de criação não mudam (42501).
-- `security definer` porque `authenticated` não lê `auth.users`; por isso o
-- sinal é só `auth.uid()` (dentro de uma definer o papel é o dono). O service
-- role, o motor e as migrations não têm `sub` e gravam o que mandarem: a
-- anonimização só mexe em corpo e anexo.
--
-- O ANEXO também (revisão do PR 128). `media_storage_path` era texto livre, e o
-- autor apontava a própria nota para o arquivo da nota de um colega em OUTRA
-- conversa (o caminho é legível para quem vê a conversa: não há nome a
-- adivinhar). A anonimização do contato DELE enfileirava então o arquivo do
-- colega, de outro paciente, para apagar (`fn_redigir_notas_internas_ao_anonimizar`
-- e o passo 6d só conferem o prefixo da organização). A regra é a da rota de
-- criar nota (`isMediaPathOwnedBy`, lib/messaging/media/upload-validation.ts):
-- `{organização}/{conversa da nota}/{arquivo}`, arquivo com nome simples. Vale
-- quando a sessão grava um caminho (INSERT), troca o caminho, ou leva para outra
-- conversa uma nota que tem anexo; caminho antigo que ninguém mexe não é
-- conferido de novo (42501 `nota_interna_anexo_fora_da_conversa`).
create or replace function public.fn_nota_interna_autoria_e_do_banco()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefixo text;
  v_arquivo text;
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.media_storage_path is not null
     and (tg_op = 'INSERT'
          or new.media_storage_path is distinct from old.media_storage_path
          or new.conversation_id is distinct from old.conversation_id
          or new.organization_id is distinct from old.organization_id) then
    v_prefixo := new.organization_id::text || '/' || new.conversation_id::text || '/';
    v_arquivo := substr(new.media_storage_path, length(v_prefixo) + 1);
    if left(new.media_storage_path, length(v_prefixo)) is distinct from v_prefixo
       or v_arquivo !~ '^[A-Za-z0-9._-]+$'
       or v_arquivo in ('.', '..') then
      raise exception 'nota_interna_anexo_fora_da_conversa' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by_name := (
      select nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '')
        from auth.users u where u.id = auth.uid()
    );
    new.created_at := now();
    return new;
  end if;
  if new.created_by_user_id is distinct from old.created_by_user_id
     or new.created_by_name is distinct from old.created_by_name
     or new.created_at is distinct from old.created_at then
    raise exception 'nota_interna_autoria_nao_muda' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.fn_nota_interna_autoria_e_do_banco() is
  'Guarda de conversation_notes (migration 0319): na escrita com sessão, o nome do autor vem de auth.users e a '
  'data é a do servidor (INSERT); autor, nome e data de criação não mudam (UPDATE, 42501 '
  'nota_interna_autoria_nao_muda); o anexo é um arquivo da conversa da própria nota, {org}/{conversa}/{arquivo} '
  '(42501 nota_interna_anexo_fora_da_conversa). O service role passa. Provado em '
  'tests/invariants/nota-interna-autoria-vem-do-banco.test.ts e nota-interna-anexo-da-propria-conversa.test.ts.';

revoke execute on function public.fn_nota_interna_autoria_e_do_banco() from public, anon, authenticated;

drop trigger if exists trg_nota_interna_autoria on public.conversation_notes;
create trigger trg_nota_interna_autoria
  before insert or update on public.conversation_notes
  for each row
  execute function public.fn_nota_interna_autoria_e_do_banco();

-- ════════════════════════════════════════════════════════════════════════════
-- 8 · O TEXTO DO CASO NÃO FICA LEGÍVEL POR UMA CÓPIA DELE
-- ════════════════════════════════════════════════════════════════════════════
-- Revisão do PR 128. A seção 2 pendurou a leitura do caso na visibilidade da
-- conversa, mas o texto dele era copiado para três tabelas com leitura
-- só-organização. Quem não vê a conversa lia a cópia.

-- (a) O aviso "caso parado" gravava o título do caso no corpo. A rota deixou de
-- gravar (app/api/v1/cron/case-stale-watcher/route.ts); isto cura os avisos que
-- já existem. Todos os estados, não só os abertos: a tabela é lida inteira pelo
-- PostgREST. O `.*` é guloso de propósito (título pode ter aspas), e depois da
-- troca a linha não casa mais: repetir não muda nada.
update public.agent_inbox_items
   set body = regexp_replace(body, '^".*" está aguardando alguém da equipe',
                             'Um caso está aguardando alguém da equipe')
 where kind = 'case_stale'
   and body ~ '^".*" está aguardando alguém da equipe';

-- (b) `demandas.assunto` recebia `agent_cases.title` do backfill R1 (0136) a cada
-- aplicação do baseline. Nenhuma tela lê a coluna e nenhum outro código a
-- escreve (rg -n "assunto" app lib components hooks workers); quem quer o título
-- vai ao caso por `agent_case_id`, que é referência e passa pela RLS do caso. O
-- R1 do baseline deixou de copiar; isto apaga as cópias já feitas. Só as de
-- origem `handoff`, que é a origem que o R1 grava.
update public.demandas
   set assunto = null
 where origem = 'handoff'
   and assunto is not null;

-- (c) `job_queue.payload` leva o texto que o humano respondeu ao caso (job
-- `case_reply_turn`) e a carga de todos os outros jobs. A sessão só precisa do
-- ESTADO do job: o único leitor com sessão é a agenda, que lê `status`
-- (app/api/v1/agenda/agendamentos/[id]/route.ts). Sai o SELECT da tabela inteira
-- (0298) e entra o das colunas de envelope; `payload` e `last_error` ficam com o
-- servidor. O bloco da 0298 no baseline foi ajustado para não devolver o SELECT
-- inteiro a cada `update.sh`. Coluna nova da fila nasce não legível pela sessão,
-- que é o lado certo para uma fila interna errar.
revoke select on public.job_queue from authenticated, anon;
grant select (id, organization_id, contact_id, kind, status, priority, run_after, attempts, max_attempts, created_at)
  on public.job_queue to authenticated;

notify pgrst, 'reload schema';
