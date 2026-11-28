-- 0442: o resumo semanal do Marketing não conta as datas do tratamento como agendamento novo (28/11/2026).
--
-- O Prontuário passa a marcar sozinho as consultas e sessões de um tratamento já pago (agenda depois do
-- pagamento, CRM-EVA#604). Esses compromissos nascem com created_by_kind = 'system' (a chave de integração,
-- valor que já estava no CHECK desde a origem da tabela). Para o resumo semanal eles não são agendamento novo:
-- o paciente converteu antes, na consulta em que fechou. Só o 'criados' muda. 'realizados', 'faltas' e
-- 'cancelados' continuam contando: são o movimento real da agenda, e as sessões acontecem de verdade.
--
-- Mesma régua do painel (lib/integrations/marketing/eventos-do-periodo.ts) desde o #604.
-- Idempotente: create or replace + os mesmos revoke/grant da 0431 (security definer: as duas origens
-- de EXECUTE, PUBLIC e anon/authenticated, revogadas; só service_role executa).
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
                    -- 0442: as datas do tratamento que o Prontuário marca (created_by_kind 'system') não são agendamento novo.
                    and a.created_by_kind <> 'system'
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
