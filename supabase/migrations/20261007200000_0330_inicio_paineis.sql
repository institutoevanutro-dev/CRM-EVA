-- 0330 — Painéis do Início (parte 3 do redesenho do CRM).
-- Spec: docs/superpowers/specs/2026-10-07-inicio-paineis-design.md. Quatro funções
-- SECURITY INVOKER (a RLS de cada tabela continua valendo) que agregam no banco —
-- o PostgREST corta leituras em 1000 linhas — e dois índices para as janelas.
-- Idempotente: create index if not exists / create or replace.
create index if not exists conversations_org_created_idx on public.conversations (organization_id, created_at);
create index if not exists contacts_org_created_idx on public.contacts (organization_id, created_at);

-- Conversas novas por dia no fuso da org. "IA sozinha" = a IA falou e ninguém da
-- equipe; "com a equipe" = alguém da equipe falou; "sem resposta" = nenhum dos dois.
create or replace function public.fn_inicio_conversas_por_dia(p_org uuid, p_inicio timestamptz, p_fim timestamptz, p_fuso text)
returns table(dia date, ia_sozinha int, com_equipe int, sem_resposta int, soma_primeira_resposta_s float8, respondidas int)
language sql stable
set search_path = public
as $$
  with conv as (
    select c.id, (c.created_at at time zone p_fuso)::date as dia
      from public.conversations c
     where c.organization_id = p_org and not c.is_group
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
    select conv.id, conv.dia,
           coalesce(bool_or(m.da_ia), false) as ia,
           coalesce(bool_or(m.da_equipe), false) as humano,
           min(m.sent_at) filter (where m.direction = 'inbound') as pri_in
      from conv
      left join msg m on m.conversation_id = conv.id
     group by conv.id, conv.dia
  ), com_resposta as (
    select p.*,
           (select min(m.sent_at) from msg m
             where m.conversation_id = p.id and (m.da_ia or m.da_equipe)
               and m.sent_at > p.pri_in) as pri_out
      from por_conv p
  )
  select p.dia,
         (count(*) filter (where p.ia and not p.humano))::int,
         (count(*) filter (where p.humano))::int,
         (count(*) filter (where not p.ia and not p.humano))::int,
         coalesce(sum(extract(epoch from p.pri_out - p.pri_in)) filter (where p.pri_out > p.pri_in), 0)::float8,
         (count(*) filter (where p.pri_out > p.pri_in))::int
    from com_resposta p
   group by p.dia
   order by p.dia;
$$;

-- Agenda por unidade. Comparecimento é calculado na rota: realizadas ÷ (realizadas + faltas).
create or replace function public.fn_inicio_agenda(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns table(unit_id uuid, unidade text, marcadas int, confirmadas int, realizadas int, faltas int, canceladas int)
language sql stable
set search_path = public
as $$
  select a.unit_id, u.name,
         (count(*) filter (where a.status <> 'cancelled'))::int,
         (count(*) filter (where a.status = 'confirmed'))::int,
         (count(*) filter (where a.status = 'completed'))::int,
         (count(*) filter (where a.status = 'no_show'))::int,
         (count(*) filter (where a.status = 'cancelled'))::int
    from public.calendar_appointments a
    left join public.calendar_units u on u.id = a.unit_id and u.organization_id = p_org
   where a.organization_id = p_org and a.starts_at >= p_inicio and a.starts_at < p_fim
   group by a.unit_id, u.name
   order by u.name nulls last;
$$;

-- Funil: abertos por etapa (sem as de ganho/perda/arquivadas), e ganhos, perdidos e
-- valor vendido por moeda no mês e no mês anterior (por closed_at).
create or replace function public.fn_inicio_funil(p_org uuid, p_pipeline uuid, p_mes_inicio timestamptz, p_mes_fim timestamptz, p_ant_inicio timestamptz)
returns jsonb
language sql stable
set search_path = public
as $$
  with janelas(janela, de, ate) as (
    values ('mes', p_mes_inicio, p_mes_fim), ('anterior', p_ant_inicio, p_mes_inicio)
  ), fechados as (
    select j.janela, l.status, coalesce(l.currency, 'BRL') as moeda, l.value_cents
      from janelas j
      join public.crm_leads l
        on l.organization_id = p_org and l.pipeline_id = p_pipeline
       and l.status in ('won', 'lost') and l.closed_at >= j.de and l.closed_at < j.ate
  ), resumo as (
    select j.janela,
           jsonb_build_object(
             'ganhos', (select count(*) from fechados f where f.janela = j.janela and f.status = 'won'),
             'perdidos', (select count(*) from fechados f where f.janela = j.janela and f.status = 'lost'),
             'valor', coalesce((
               select jsonb_object_agg(v.moeda, v.total::text)
                 from (select f.moeda, sum(f.value_cents) as total from fechados f
                        where f.janela = j.janela and f.status = 'won' and f.value_cents is not null
                        group by f.moeda) v), '{}'::jsonb)
           ) as bloco
      from janelas j
  )
  select jsonb_build_object(
    'etapas', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.name, 'abertos', (
               select count(*) from public.crm_leads l
                where l.organization_id = p_org and l.stage_id = s.id and l.status = 'open'))
             order by s.position)
        from public.crm_stages s
       where s.organization_id = p_org and s.pipeline_id = p_pipeline
         and not s.is_archived and not s.is_won and not s.is_lost), '[]'::jsonb),
    'mes', (select r.bloco from resumo r where r.janela = 'mes'),
    'anterior', (select r.bloco from resumo r where r.janela = 'anterior'));
$$;

-- Origem dos contatos novos (sem anonimizados nem mesclados), com o utm_source quando houver.
create or replace function public.fn_inicio_origem(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns table(origem text, utm_source text, total int)
language sql stable
set search_path = public
as $$
  select coalesce(nullif(c.source, ''), 'manual'), nullif(c.source_metadata ->> 'utm_source', ''), count(*)::int
    from public.contacts c
   where c.organization_id = p_org and c.created_at >= p_inicio and c.created_at < p_fim
     and not c.is_anonymized and c.merged_at is null
   group by 1, 2
   order by 3 desc;
$$;

revoke execute on function public.fn_inicio_conversas_por_dia(uuid, timestamptz, timestamptz, text) from public, anon;
revoke execute on function public.fn_inicio_agenda(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.fn_inicio_funil(uuid, uuid, timestamptz, timestamptz, timestamptz) from public, anon;
revoke execute on function public.fn_inicio_origem(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_inicio_conversas_por_dia(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.fn_inicio_agenda(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.fn_inicio_funil(uuid, uuid, timestamptz, timestamptz, timestamptz) to authenticated;
grant execute on function public.fn_inicio_origem(uuid, timestamptz, timestamptz) to authenticated;
