-- 0431: resumo semanal do Marketing (pedido do André, 22/11/2026).
-- (1) Registro de envio: uma vez por semana por número; o teste usa semana "teste-AAAA-MM-DD".
--     Deny-all (sem policy), como ad_platform_connections (0213): só o admin client do endpoint
--     de integração escreve, com o organization_id do env.
-- (2) fn_marketing_semana: agregados da semana (mensagens por origem, agenda e quem marcou).
--     Sem paciente: só contagens e o nome de quem da equipe marcou.
create table if not exists public.marketing_resumo_envios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  semana text not null check (semana ~ '^([0-9]{4}-W[0-9]{2}|teste-[0-9]{4}-[0-9]{2}-[0-9]{2})$'),
  telefone text not null check (telefone ~ '^[0-9]{10,15}$'),
  status text not null default 'enviando' check (status in ('enviando','enviado','falhou')),
  erro text,
  message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_resumo_envios_uma_vez unique (organization_id, semana, telefone)
);
alter table public.marketing_resumo_envios enable row level security;
revoke all on table public.marketing_resumo_envios from anon, authenticated;

create or replace function public.fn_marketing_semana(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('via', via, 'mensagens', n, 'conversas', c) order by n desc)
        from (select coalesce(m.sent_via, 'outro') as via, count(*)::int as n, count(distinct m.conversation_id)::int as c
                from public.messages m join public.conversations cv on cv.id = m.conversation_id
               where m.organization_id = p_org and m.direction = 'outbound' and m.status <> 'failed'
                 and not cv.is_group and m.created_at >= p_inicio and m.created_at < p_fim
               group by 1) x), '[]'::jsonb),
    'recebidas', (select count(*)::int from public.messages m join public.conversations cv on cv.id = m.conversation_id
                   where m.organization_id = p_org and m.direction = 'inbound' and not cv.is_group
                     and m.created_at >= p_inicio and m.created_at < p_fim),
    'agenda', jsonb_build_object(
      -- Mesma régua do funil (eventos-do-periodo.ts): importação de histórico não é agendamento da
      -- semana, e a remarcação cria linha nova que não é agendamento novo.
      'criados', (select count(*)::int from public.calendar_appointments a where a.organization_id = p_org and a.excluded_at is null
                    and a.source <> 'historical_import' and a.rescheduled_from_id is null
                    and a.created_at >= p_inicio and a.created_at < p_fim),
      'realizados', (select count(*)::int from public.calendar_appointments a where a.organization_id = p_org and a.excluded_at is null
                    and a.source <> 'historical_import' and a.status = 'completed' and a.starts_at >= p_inicio and a.starts_at < p_fim),
      'faltas', (select count(*)::int from public.calendar_appointments a where a.organization_id = p_org and a.excluded_at is null
                    and a.source <> 'historical_import' and a.status = 'no_show' and a.starts_at >= p_inicio and a.starts_at < p_fim),
      'cancelados', (select count(*)::int from public.calendar_appointments a where a.organization_id = p_org and a.excluded_at is null
                    and a.source <> 'historical_import' and a.status = 'cancelled' and a.starts_at >= p_inicio and a.starts_at < p_fim)
    ),
    'quem_marcou', coalesce((
      select jsonb_agg(jsonb_build_object('nome', nome, 'total', n) order by n desc)
        from (select case when a.created_by_kind = 'ai' or a.source = 'mcp' then 'Atendente virtual'
                          else coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), 'Equipe') end as nome,
                     count(*)::int as n
                from public.calendar_appointments a left join auth.users u on u.id = a.created_by_user_id
               where a.organization_id = p_org and a.excluded_at is null and a.created_by_kind in ('user', 'ai')
                 and a.source <> 'historical_import' and a.rescheduled_from_id is null
                 and a.created_at >= p_inicio and a.created_at < p_fim
               group by 1 order by 2 desc limit 8) x), '[]'::jsonb)
  );
$$;
revoke execute on function public.fn_marketing_semana(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_marketing_semana(uuid, timestamptz, timestamptz) to service_role;

notify pgrst, 'reload schema';
