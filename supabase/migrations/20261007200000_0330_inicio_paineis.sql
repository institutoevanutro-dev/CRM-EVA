-- 0330 — Painéis do Início (parte 3 do redesenho do CRM).
-- Spec: docs/superpowers/specs/2026-10-07-inicio-paineis-design.md. Quatro funções
-- SECURITY INVOKER (a RLS de cada tabela continua valendo) que agregam no banco —
-- o PostgREST corta leituras em 1000 linhas — e dois índices para as janelas.
-- Idempotente: create index if not exists / create or replace.
create index if not exists conversations_org_created_idx on public.conversations (organization_id, created_at);
create index if not exists contacts_org_created_idx on public.contacts (organization_id, created_at);

-- Conversas novas por dia no fuso da org. "IA sozinha" = houve saída e nenhuma
-- mensagem humana; "com a equipe" = houve mensagem humana; "sem resposta" = sem saída.
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
  ), por_conv as (
    select conv.id, conv.dia,
           coalesce(bool_or(m.direction = 'outbound'), false) as saiu,
           coalesce(bool_or(m.direction = 'outbound' and (m.sent_by_user_id is not null
                    or m.sent_via in ('crm', 'user', 'external_device'))), false) as humano,
           min(m.sent_at) filter (where m.direction = 'inbound') as pri_in,
           min(m.sent_at) filter (where m.direction = 'outbound') as pri_out
      from conv
      left join public.messages m on m.conversation_id = conv.id and m.organization_id = p_org
     group by conv.id, conv.dia
  )
  select p.dia,
         (count(*) filter (where p.saiu and not p.humano))::int,
         (count(*) filter (where p.humano))::int,
         (count(*) filter (where not p.saiu))::int,
         coalesce(sum(extract(epoch from p.pri_out - p.pri_in)) filter (where p.pri_out > p.pri_in), 0)::float8,
         (count(*) filter (where p.pri_out > p.pri_in))::int
    from por_conv p
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
