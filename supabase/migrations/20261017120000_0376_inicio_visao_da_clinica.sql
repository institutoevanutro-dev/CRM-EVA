-- 0376 — "Visão da clínica" do Início: o resumo que faltava às funções da 0330.
--
-- Pedido do dono do produto (17/10/2026): a Visão da clínica vira painel de
-- gestão de verdade — agenda por PROFISSIONAL (a 0330 só agrupa por unidade),
-- conversas esperando resposta AGORA e leads novos/ganhos no mês com o mês
-- anterior ao lado.
--
-- Por que no banco: o PostgREST corta leituras em 1000 linhas, e "a última
-- mensagem é do paciente" compara duas colunas (`last_inbound_at >
-- last_outbound_at`), o que ele não filtra. Uma chamada, tudo agregado aqui.
--
-- SECURITY INVOKER, como as da 0330: a RLS de cada tabela continua valendo, e um
-- membro que pede outra organização recebe ZERO. Quem decide que só gerente e
-- admin veem é a rota (`requireRole("manager")` em /api/v1/inicio/paineis).
--
-- O profissional é `calendar_appointments.owner_user_id`. O nome NÃO sai daqui:
-- mora em auth.users, que uma função invoker não lê — a rota resolve com
-- `nomesDosAtendentes`.
--
-- Idempotente (create or replace) e sem tabela, coluna ou constraint nova.
create or replace function public.fn_inicio_resumo_da_clinica(
  p_org uuid,
  p_hoje_inicio timestamptz,
  p_hoje_fim timestamptz,
  p_semana_inicio timestamptz,
  p_semana_fim timestamptz,
  p_mes_inicio timestamptz,
  p_mes_fim timestamptz,
  p_ant_inicio timestamptz
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
    'esperando', (
      select jsonb_build_object(
               'total', count(*)::int,
               'sem_responsavel', (count(*) filter (where c.assigned_to_user_id is null))::int,
               'desde', min(coalesce(c.awaiting_since, c.last_inbound_at)))
        from public.conversations c
       where c.organization_id = p_org
         and not c.is_group
         and not c.contato_oculto
         and c.status not in ('resolved', 'closed', 'archived')
         and c.last_inbound_at is not null
         and (c.last_outbound_at is null or c.last_inbound_at > c.last_outbound_at)
    ),
    'leads', (
      select jsonb_build_object(
               'novos_mes', (count(*) filter (where l.created_at >= p_mes_inicio and l.created_at < p_mes_fim))::int,
               'novos_anterior', (count(*) filter (where l.created_at >= p_ant_inicio and l.created_at < p_mes_inicio))::int,
               'ganhos_mes', (count(*) filter (where l.status = 'won'
                                                 and l.closed_at >= p_mes_inicio and l.closed_at < p_mes_fim))::int,
               'ganhos_anterior', (count(*) filter (where l.status = 'won'
                                                      and l.closed_at >= p_ant_inicio and l.closed_at < p_mes_inicio))::int)
        from public.crm_leads l
       where l.organization_id = p_org
         and (l.created_at >= p_ant_inicio or l.closed_at >= p_ant_inicio)
    )
  );
$$;

-- As DUAS origens de EXECUTE saem (CLAUDE.md, item 9); só quem tem sessão chama.
revoke execute on function public.fn_inicio_resumo_da_clinica(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_inicio_resumo_da_clinica(uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
