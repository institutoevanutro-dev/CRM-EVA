-- Migration 0388 : O RELATÓRIO POR CANAL — volume de conversas, 1ª resposta
-- HUMANA e conversas sem resposta, por número/conexão.
--
-- Portado do projeto original (DeskcommCRM, PR #2504 de @webtecnica, lá
-- migration 0590), já na forma do conserto de desempenho do PR #2554 de
-- @Tong-bit-art (lá 0596): as conversas são recortadas pela JANELA antes do
-- `cross join lateral` sobre `messages`.
--
-- `fn_channel_metrics(p_org, p_from, p_to, p_owner)` é SECURITY INVOKER e
-- `stable`, no molde de `fn_attendant_metrics` (0037): a RLS de
-- `conversations` e `messages` é o portão (isolamento por organização e a
-- visibilidade do papel), e `organization_id = p_org` vem da sessão na rota,
-- nunca do corpo. A régua é a mesma da irmã: contagem e "sem resposta" pela
-- janela semiaberta em `assigned_at`; 1ª resposta humana = primeira mensagem
-- de saída com `sent_by_user_id` depois da primeira de entrada (bot de fora).
-- Só o `group by` muda: `channel_session_id`.
--
-- LGPD: só AGREGADOS. Cada linha é um número/conexão da CLÍNICA (telefone,
-- nome de exibição ou nome da sessão do canal) com contagens e média — nenhum
-- nome, telefone ou texto de paciente sai daqui.
--
-- Índice novo: `idx_messages_org_saida_humana_sent` (parcial, abaixo).
-- Read-only (sem auditoria: não é mutação). Idempotente (create or replace),
-- portável em psql puro. Revoga EXECUTE de public e anon; só authenticated e
-- service_role executam. No baseline, bloco antes da VARREDURA anon.
-- O recorte da 1ª resposta lê `messages` por organização + saída humana +
-- `sent_at`. Este fork não tem o índice que o original usa (0133 de lá), então
-- ele nasce aqui, parcial (só mensagens de saída escritas por gente), para o
-- custo acompanhar a janela e não o histórico. `if not exists`: idempotente.
create index if not exists idx_messages_org_saida_humana_sent
  on public.messages (organization_id, sent_at)
  where direction = 'outbound' and sent_by_user_id is not null;

create or replace function public.fn_channel_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- ─── #2514: o recorte ANTES do lateral, não depois dele ────────────────────
  --
  -- A irmã lia TODA conversa da organização com `channel_session_id` e pagava o
  -- lateral (`messages`, com a RLS de `messages` por linha) para cada uma; a
  -- janela só cortava dentro do agregado, então 1 dia e 90 dias custavam igual
  -- (medido: 13,971 s contra 14,068 s).
  --
  -- As duas condições são as que a SAÍDA exige, e nada mais:
  --
  --   (a) `assigned_at` na janela — é o predicado de `conversations_handled` e
  --       de `sem_resposta`, que já existia no `count(*) filter`;
  --   (b) mensagem humana de saída na janela — é o caso necessário de
  --       `first_human_out >= p_from and < p_to`: toda conversa cuja 1ª
  --       resposta humana cai na janela TEM uma mensagem humana de saída na
  --       janela, porque a 1ª é uma delas.
  --
  -- Linha que fica de fora não movia nenhum número: contagem 0, vazamento 0,
  -- média nula. Ela só pagava o lateral. O `UNION` deduplica as que são as duas
  -- coisas ao mesmo tempo.
  --
  -- Custos cobertos por índice que já existe, um para cada ramo:
  -- `idx_conversations_org_assignee_assigned` (0037) em (a) e
  -- `idx_messages_org_direction_sent` (0133) em (b).
  candidatas as (
    -- (a) recorte da contagem e do vazamento: janela semiaberta em
    -- `assigned_at`, com o resto dos predicados do `conv_agg` da irmã — são os
    -- mesmos que o `where` de `conversas` já exige, e juntos casam com o índice.
    select c.id
    from public.conversations c
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and c.channel_session_id is not null
      and c.assigned_at >= p_from and c.assigned_at < p_to
      and (p_owner is null or c.assigned_to_user_id = p_owner)
    union
    -- (b) recorte da média: 1ª resposta humana na janela.
    select c.id
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where m.organization_id = p_org
      and m.direction = 'outbound'
      and m.sent_by_user_id is not null
      and m.sent_at >= p_from
      and m.sent_at < p_to
  ),
  -- Uma linha por conversa na régua de ATRIBUIÇÃO da irmã (0037 §6.5).
  -- O lateral e o seu `where` estão intactos: o que mudou é que ele roda para as
  -- candidatas, e não para a organização inteira.
  conversas as (
    select
      c.channel_session_id as channel_session_id,
      c.channel as channel,
      c.assigned_at as assigned_at,
      fr.first_in,
      fr.first_human_out
    from public.conversations c
    join candidatas k on k.id = c.id
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.channel_session_id is not null
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
  ),
  -- Uma linha por canal: volume, 1ª resposta humana e vazamento no MESMO
  -- `group by`, para a soma nunca divergir da média.
  canais as (
    select
      c.channel_session_id,
      -- O tipo é constante por sessão (0027/0368): `max()` agrupa uma coluna
      -- funcionalmente dependente, não inventa valor.
      max(c.channel) as channel,
      -- Critério 1: volume por canal, janela semiaberta em `assigned_at`.
      count(*) filter (
        where c.assigned_at >= p_from and c.assigned_at < p_to
      ) as conversations_handled,
      -- Critério 3: o vazamento — conversa da janela que NUNCA teve 1ª resposta
      -- humana. Conta aqui e só aqui; nunca mexe na média.
      count(*) filter (
        where c.assigned_at >= p_from and c.assigned_at < p_to
          and c.first_human_out is null
      ) as sem_resposta,
      -- Critérios 2 e 4: a MESMA fórmula da irmã — bot fora e `t1 <= t0`
      -- descartado. Sem par válido a média fica `null` (não medida), nunca 0.
      avg(extract(epoch from (c.first_human_out - c.first_in))) filter (
        where c.first_in is not null
          and c.first_human_out is not null
          and c.first_human_out > c.first_in
          and c.first_human_out >= p_from and c.first_human_out < p_to
      ) as avg_first_response_seconds
    from conversas c
    group by c.channel_session_id
  )
  select jsonb_build_object(
    'channels', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'channel_session_id', k.channel_session_id,
          'channel_name', coalesce(cs.phone_number, cs.display_name, cs.waha_session_name),
          'channel', k.channel,
          'is_archived', (cs.archived_at is not null),
          'conversations_handled', k.conversations_handled,
          'avg_first_response_seconds', k.avg_first_response_seconds,
          'sem_resposta', k.sem_resposta
        ) order by k.conversations_handled desc, k.channel_session_id
      )
      from canais k
      left join public.channel_sessions cs on cs.id = k.channel_session_id
      -- Critério 5: canal sem atividade na janela não é linha, é ruído — a
      -- resposta sem dado é `[]` e a tela diz "Sem atividade no período".
      where k.conversations_handled > 0
         or k.sem_resposta > 0
         or k.avg_first_response_seconds is not null
    ), '[]'::jsonb)
  );
$$;
revoke execute on function public.fn_channel_metrics(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.fn_channel_metrics(uuid, timestamptz, timestamptz, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
