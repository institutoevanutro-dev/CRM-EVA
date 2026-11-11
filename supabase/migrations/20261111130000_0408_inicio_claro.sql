-- 0408 — Início claro: os números da primeira tela passam a dizer o que parecem dizer.
--
-- Pedido do dono do produto (11/11/2026): a página Início tinha números
-- verdadeiros que enganavam. Medido em produção, só contagens:
--   - "Pacientes esperando resposta" contava só conversa atribuída à pessoa: com
--     788 conversas abertas sem responsável, o quadro dizia "ninguém";
--   - "Esperando resposta 210" somava espera de qualquer idade (113 delas com
--     mais de 7 dias);
--   - "794 leads a menos que o mês anterior" comparava o mês pela metade com o
--     anterior inteiro;
--   - "10 h 58 m até a primeira resposta" era MÉDIA, puxada por poucas conversas
--     esquecidas; a mediana é perto de zero;
--   - "Negócios ganhos 3 (todos os funis)" ao lado de "Funil: 0 ganhos".
--
-- O que muda no banco (só funções; nenhuma tabela, coluna ou constraint):
--
--   1. `fn_inicio_esperando(p_org, p_corte)` — NOVA. A regra de "esperando
--      resposta" num lugar só, para o "Meu dia" e para a "Visão da clínica": não
--      é grupo, não é contato oculto, está aberta e a última mensagem é do
--      paciente. `p_corte` separa a espera RECENTE (começou depois dele) da
--      antiga; quem chama passa agora menos 3 dias (`DIAS_DE_ESPERA_RECENTE`, em
--      lib/inicio/tipos.ts). Devolve os totais, o recorte "com você" (auth.uid())
--      e "sem responsável", e as 5 esperas recentes mais antigas entre essas duas.
--
--   2. `fn_inicio_atendimento(p_org, p_inicio, p_fim)` — NOVA, no lugar de
--      `fn_inicio_conversas_por_dia`, que SAI: o gráfico por dia deu lugar a uma
--      barra só, e a MEDIANA do tempo até a primeira resposta não se monta a
--      partir de somas por dia. Mesma régua de autoria da antiga (IA sozinha,
--      com a equipe, sem resposta).
--
--   3. `fn_inicio_resumo_da_clinica` — ganha `p_ant_fim` (o fim dos MESMOS DIAS
--      do mês anterior) e troca o bloco `leads` por `vendas`: pacientes novos no
--      mês e nos mesmos dias do anterior, vendas fechadas, desistências e valor
--      vendido por moeda, somando TODOS os funis. O bloco `esperando` sai (foi
--      para a função 1). A assinatura muda, então a de oito argumentos sai antes.
--
-- As três são SECURITY INVOKER, como as da 0330 e da 0376: a RLS de quem lê
-- continua valendo. É ela que impede `fn_inicio_esperando` de contar conversa
-- que a pessoa não consegue abrir (`fn_can_view_conversation`: o profissional só
-- vê as dele; o atendente segue `organizations.settings.visibility_mode`).
-- `ve_sem_responsavel` devolve essa mesma régua para a tela não mostrar um zero
-- que engana a quem não pode ver conversa sem responsável.
--
-- As DUAS origens de EXECUTE saem (public e anon); só `authenticated` chama.
-- Idempotente. No baseline: as duas novas entram num bloco antes da varredura
-- anon; `fn_inicio_resumo_da_clinica` é trocada no lugar (bloco da 0376); e as
-- duas definições de `fn_inicio_conversas_por_dia` (blocos da 0330 e da 0372)
-- saem do texto, ficando só o `drop ... if exists` para quem já instalou.
-- Prova: tests/invariants/inicio-esperando.test.ts, inicio-paineis.test.ts e
-- inicio-visao-da-clinica.test.ts.

create or replace function public.fn_inicio_esperando(p_org uuid, p_corte timestamptz)
returns jsonb
language sql stable
set search_path = public
as $$
  with esperando as (
    select c.id, c.contact_id, c.assigned_to_user_id,
           coalesce(c.awaiting_since, c.last_inbound_at) as desde
      from public.conversations c
     where c.organization_id = p_org
       and not c.is_group
       and not c.contato_oculto
       and c.status not in ('resolved', 'closed', 'archived')
       and c.last_inbound_at is not null
       and (c.last_outbound_at is null or c.last_inbound_at > c.last_outbound_at)
  ), marcadas as (
    select e.*,
           e.desde >= p_corte as recente,
           coalesce(e.assigned_to_user_id = auth.uid(), false) as com_voce,
           e.assigned_to_user_id is null as sem_responsavel
      from esperando e
  )
  select jsonb_build_object(
    've_sem_responsavel', coalesce(public.fn_can_view_conversation(p_org, null), false),
    'recentes', jsonb_build_object(
      'total', (count(*) filter (where m.recente))::int,
      'com_voce', (count(*) filter (where m.recente and m.com_voce))::int,
      'sem_responsavel', (count(*) filter (where m.recente and m.sem_responsavel))::int),
    'antigas', jsonb_build_object(
      'total', (count(*) filter (where not m.recente))::int,
      'com_voce', (count(*) filter (where not m.recente and m.com_voce))::int,
      'sem_responsavel', (count(*) filter (where not m.recente and m.sem_responsavel))::int),
    'itens', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'desde', i.desde,
               'name', ct.name, 'display_name', ct.display_name, 'phone_number', ct.phone_number)
             order by i.desde, i.id)
        from (
          select x.id, x.contact_id, x.desde
            from marcadas x
           where x.recente and (x.com_voce or x.sem_responsavel)
           order by x.desde, x.id
           limit 5
        ) i
        left join public.contacts ct on ct.id = i.contact_id and ct.organization_id = p_org
    ), '[]'::jsonb))
    from marcadas m;
$$;

create or replace function public.fn_inicio_atendimento(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns jsonb
language sql stable
set search_path = public
as $$
  with conv as (
    select c.id
      from public.conversations c
     where c.organization_id = p_org and not c.is_group and not c.contato_oculto
       and c.created_at >= p_inicio and c.created_at < p_fim
  ), msg as (
    -- sent_via='ai' cobre QUALQUER ator não humano (lembrete, campanha, automação);
    -- fala da IA é a marca de autoria, a mesma régua de ehFalaDaIa
    -- (lib/ai/handoff/aviso-ao-lead.ts). Envio que falhou não é resposta.
    select m.conversation_id, m.direction, m.sent_at,
           (m.direction = 'outbound' and m.status <> 'failed'
             and coalesce(m.metadata->>'aviso_de_escalacao', '') <> 'true'
             and (jsonb_typeof(m.metadata->'ai_actor_id') = 'string'
                  or m.metadata->>'ai_generated' = 'true'
                  or m.metadata->>'texto_escrito_pela_ia' = 'true')) as da_ia,
           (m.direction = 'outbound' and m.status <> 'failed'
             and (m.sent_by_user_id is not null or m.sent_via in ('user', 'external_device'))) as da_equipe
      from public.messages m
      join conv on conv.id = m.conversation_id
     where m.organization_id = p_org
  ), por_conv as (
    select conv.id,
           coalesce(bool_or(m.da_ia), false) as ia,
           coalesce(bool_or(m.da_equipe), false) as humano,
           min(m.sent_at) filter (where m.direction = 'inbound') as pri_in
      from conv
      left join msg m on m.conversation_id = conv.id
     group by conv.id
  ), com_resposta as (
    select p.*,
           (select min(m.sent_at) from msg m
             where m.conversation_id = p.id and (m.da_ia or m.da_equipe)
               and m.sent_at > p.pri_in) as pri_out
      from por_conv p
  )
  select jsonb_build_object(
    'ia_sozinha', (count(*) filter (where p.ia and not p.humano))::int,
    'com_equipe', (count(*) filter (where p.humano))::int,
    'sem_resposta', (count(*) filter (where not p.ia and not p.humano))::int,
    -- Mediana, não média: uma conversa esquecida por dias não arrasta o número.
    'mediana_primeira_resposta_s',
      percentile_cont(0.5) within group (order by extract(epoch from p.pri_out - p.pri_in))
        filter (where p.pri_out > p.pri_in))
    from com_resposta p;
$$;

drop function if exists public.fn_inicio_conversas_por_dia(uuid, timestamptz, timestamptz, text);

drop function if exists public.fn_inicio_resumo_da_clinica(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz);

create or replace function public.fn_inicio_resumo_da_clinica(
  p_org uuid,
  p_hoje_inicio timestamptz,
  p_hoje_fim timestamptz,
  p_semana_inicio timestamptz,
  p_semana_fim timestamptz,
  p_mes_inicio timestamptz,
  p_mes_fim timestamptz,
  p_ant_inicio timestamptz,
  p_ant_fim timestamptz
)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'profissionais', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.semana desc, p.user_id)
        from (
          select a.owner_user_id as user_id,
                 (count(*) filter (where a.status <> 'cancelled'
                                     and a.starts_at >= p_hoje_inicio and a.starts_at < p_hoje_fim))::int as hoje,
                 (count(*) filter (where a.status <> 'cancelled'))::int as semana,
                 (count(*) filter (where a.status = 'completed'))::int as realizadas,
                 (count(*) filter (where a.status = 'no_show'))::int as faltas,
                 (count(*) filter (where a.status = 'cancelled'))::int as canceladas,
                 coalesce(round(sum(extract(epoch from (a.ends_at - a.starts_at)) / 60)
                   filter (where a.status <> 'cancelled')), 0)::int as minutos
            from public.calendar_appointments a
           where a.organization_id = p_org
             and a.excluded_at is null
             and a.starts_at >= p_semana_inicio and a.starts_at < p_semana_fim
           group by a.owner_user_id
        ) p
    ), '[]'::jsonb),
    -- TODOS os funis. `novos_anterior` conta só até `p_ant_fim`: os mesmos dias
    -- do mês anterior, nunca o mês anterior inteiro contra o mês pela metade.
    'vendas', (
      select jsonb_build_object(
               'novos_mes', (count(*) filter (where l.created_at >= p_mes_inicio and l.created_at < p_mes_fim))::int,
               'novos_anterior', (count(*) filter (where l.created_at >= p_ant_inicio and l.created_at < p_ant_fim))::int,
               'ganhos_mes', (count(*) filter (where l.status = 'won'
                                                 and l.closed_at >= p_mes_inicio and l.closed_at < p_mes_fim))::int,
               'perdidos_mes', (count(*) filter (where l.status = 'lost'
                                                   and l.closed_at >= p_mes_inicio and l.closed_at < p_mes_fim))::int,
               'valor', coalesce((
                 select jsonb_object_agg(v.moeda, v.total::text)
                   from (select coalesce(g.currency, 'BRL') as moeda, sum(g.value_cents) as total
                           from public.crm_leads g
                          where g.organization_id = p_org and g.status = 'won' and g.value_cents is not null
                            and g.closed_at >= p_mes_inicio and g.closed_at < p_mes_fim
                          group by 1) v), '{}'::jsonb))
        from public.crm_leads l
       where l.organization_id = p_org
         and (l.created_at >= p_ant_inicio or l.closed_at >= p_mes_inicio)
    )
  );
$$;

-- As DUAS origens de EXECUTE saem (CLAUDE.md, item 9); só quem tem sessão chama.
revoke execute on function public.fn_inicio_esperando(uuid, timestamptz) from public, anon;
revoke execute on function public.fn_inicio_atendimento(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.fn_inicio_resumo_da_clinica(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_inicio_esperando(uuid, timestamptz) to authenticated;
grant execute on function public.fn_inicio_atendimento(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.fn_inicio_resumo_da_clinica(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
