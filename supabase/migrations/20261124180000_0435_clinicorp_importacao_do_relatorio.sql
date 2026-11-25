-- 0435: o que JÁ está marcado na Clinicorp entra pela importação do relatório.
--
-- ─── O caso ──────────────────────────────────────────────────────────────────
--
-- A clínica sem o módulo API Externa recebe pela "Gestão de Webhook" (0434) só o
-- que muda dali em diante. O que já estava marcado antes não chega por ali. O
-- caminho oficial que existe é o relatório Clinicorp › Relatórios ›
-- Agendamentos › Geral › Exportar (.xlsx), medido em 24/11/2026: data, "HH:MM
-- às HH:MM", nome do profissional e status, mais paciente e contato. NÃO tem o
-- id do agendamento nem o do profissional.
--
-- O arquivo é lido NO NAVEGADOR (`lib/agenda/clinicorp/exportacao.ts`) e nunca
-- chega ao servidor. A rota recebe só dia, início, fim e a pessoa da Agenda que o
-- gestor escolheu para cada nome de profissional; nome sem pessoa fica de fora.
--
-- ─── Por que tabela própria, e não `calendar_clinicorp_events` ──────────────
--
-- Sem o id da Clinicorp não há chave para o webhook atualizar ou cancelar o que
-- veio do relatório, e `calendar_clinicorp_events.external_id` É esse id. Então o
-- importado é uma FOTO: cada importação substitui a anterior inteira
-- (`fn_agenda_clinicorp_importar`, numa instrução só), e "Desligar" a apaga em
-- cascata pela integração. Horário importado que depois for desmarcado segue
-- ocupado até a próxima importação: bloquear demais é o lado seguro; marcar em
-- cima de alguém, não.
--
-- A mesma régua da 0433: `organization_id` em tudo, RLS ligada com policy de
-- select só da organização como segunda tranca, privilégio NENHUM para `anon` e
-- `authenticated`, escrita só pelo service role.
--
-- ─── A ocupação externa do dono ──────────────────────────────────────────────
--
-- `fn_agenda_ocupacao_externa_do_dono` (0433) ganha um terceiro ramo: a foto
-- importada da pessoa. É `create or replace` com a MESMA assinatura e o MESMO
-- retorno, a partir da versão da 0433 (a única), com os dois ramos de antes
-- intactos. Sem nada importado, a resposta é a mesma de antes (medido em
-- `tests/invariants/agenda-clinicorp-importacao.test.ts`).

create table if not exists public.calendar_clinicorp_imported_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint calendar_clinicorp_imported_events_periodo_valido check (ends_at > starts_at),
  constraint calendar_clinicorp_imported_events_integracao_fk foreign key (organization_id)
    references public.calendar_clinicorp_integrations(organization_id) on delete cascade
);

create index if not exists calendar_clinicorp_imported_events_ocupam_idx
  on public.calendar_clinicorp_imported_events (organization_id, user_id, starts_at);

comment on table public.calendar_clinicorp_imported_events is
  'Migration 0435: a foto do que já estava marcado na Clinicorp, importada do relatório exportado (lido no navegador). Só a pessoa da Agenda, início e fim: nada do paciente. Cada importação substitui a anterior.';

alter table public.calendar_clinicorp_imported_events enable row level security;
revoke all on table public.calendar_clinicorp_imported_events from anon, authenticated;
grant select, insert, update, delete on table public.calendar_clinicorp_imported_events to service_role;

do $politica$ begin -- só recria quando a definição no banco não é esta (reaplicar-o-baseline-nao-abre-janela.test.ts)
if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'calendar_clinicorp_imported_events' and policyname = 'tenant_isolation_calendar_clinicorp_imported_events_select'
    and md5(concat_ws('|', permissive, cmd, roles::text, coalesce(qual, '~'), coalesce(with_check, '~'))) = 'ee7e7ff06c35a294715a7034954149bb') then
drop policy if exists tenant_isolation_calendar_clinicorp_imported_events_select on public.calendar_clinicorp_imported_events;
create policy tenant_isolation_calendar_clinicorp_imported_events_select on public.calendar_clinicorp_imported_events
  for select to authenticated using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
end if;
end $politica$;

-- A importação: apaga a foto anterior e grava a nova, numa instrução só (CTE que
-- escreve sempre executa). Linha repetida no lote entra uma vez.
create or replace function public.fn_agenda_clinicorp_importar(p_org uuid, p_itens jsonb)
returns integer
language sql
volatile
set search_path = public
as $$
  with apagados as (
    delete from public.calendar_clinicorp_imported_events where organization_id = p_org
    returning 1
  ),
  gravados as (
    insert into public.calendar_clinicorp_imported_events (organization_id, user_id, starts_at, ends_at)
    select distinct p_org, x.user_id, x.starts_at, x.ends_at
      from jsonb_to_recordset(coalesce(p_itens, '[]'::jsonb)) as x(user_id uuid, starts_at timestamptz, ends_at timestamptz)
    returning 1
  )
  select count(*)::integer from gravados;
$$;

revoke execute on function public.fn_agenda_clinicorp_importar(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_agenda_clinicorp_importar(uuid, jsonb) to service_role;

create or replace function public.fn_agenda_ocupacao_externa_do_dono(
  p_org uuid,
  p_owner uuid,
  p_de timestamptz,
  p_ate timestamptz
)
returns table (
  starts_at timestamptz,
  ends_at timestamptz,
  transparency text,
  status text,
  connection_status text,
  fonte text
)
language sql
stable
security definer
set search_path = public
as $$
  -- O Google, como a 0260 o entrega: a mesma função, sem nenhuma mudança.
  select g.starts_at, g.ends_at, g.transparency, g.status, g.connection_status, 'google'::text
    from public.fn_agenda_ocupacao_google_do_dono(p_org, p_owner, p_de, p_ate) g
  union all
  -- A Clinicorp: só o que está mapeado para ESTE dono. A cópia que falhou na
  -- última tentativa segue ocupando (o compromisso continua existindo lá) e
  -- avisa como fonte defasada.
  select o.starts_at, o.ends_at, 'opaque'::text, o.status,
         case when i.last_sync_error is null then 'healthy' else 'error' end,
         'clinicorp'::text
    from public.calendar_clinicorp_events o
    join public.calendar_clinicorp_professionals p
      on p.organization_id = o.organization_id
     and p.professional_id = o.professional_id
    join public.calendar_clinicorp_integrations i
      on i.organization_id = o.organization_id
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and o.organization_id = p_org
     and p.user_id = p_owner
     and o.status <> 'cancelled'
     -- Cruzamento ESTRITO, a régua de `colide`: encostar não é ocupar.
     and o.starts_at < p_ate
     and o.ends_at > p_de
  union all
  -- A foto importada do relatório da Clinicorp (0435): já ligada à pessoa.
  select m.starts_at, m.ends_at, 'opaque'::text, 'confirmed'::text, 'healthy'::text, 'clinicorp'::text
    from public.calendar_clinicorp_imported_events m
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and m.organization_id = p_org
     and m.user_id = p_owner
     and m.starts_at < p_ate
     and m.ends_at > p_de;
$$;

-- `create or replace` mantém os grants da 0433; reafirmados para o banco que
-- chegar aqui sem eles (as DUAS origens de EXECUTE, CLAUDE.md).
revoke execute on function public.fn_agenda_ocupacao_externa_do_dono(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function public.fn_agenda_ocupacao_externa_do_dono(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
