-- 0433: a ocupação da Clinicorp entra na Agenda, e o dia aberto leva a unidade.
--
-- ─── O caso ──────────────────────────────────────────────────────────────────
--
-- Uma clínica marca as consultas numa agenda de fora, a Clinicorp, e não no CRM.
-- A IA precisa saber o que já está tomado para oferecer horário. A Clinicorp não
-- sincroniza com o Google; o que ela tem é uma API REST documentada
-- (https://sistema.clinicorp.com/api-docs/), com `GET /appointment/list`. O CRM
-- COPIA dali só a ocupação (início, fim, profissional, clínica, situação e id) e
-- soma à que o motor já desconta. A jornada continua sendo a do CRM.
--
-- ─── (1) O dia aberto leva a unidade ─────────────────────────────────────────
--
-- `calendar_availability_exceptions` com `is_unavailable = false` SUBSTITUI a
-- jornada daquele dia (`janelasDoDia`, `lib/agenda/horarios-livres.ts`), mas o
-- horário saía com `unitId: null`: um "dia em outra unidade" lançado pela tela
-- virava horário sem unidade. A coluna nova leva a unidade; o motor a entrega no
-- slot. Só faz sentido no dia ABERTO (fechar "só numa unidade" não existe no
-- motor), e o CHECK diz isso. FK composta como a de `calendar_appointments`: a
-- unidade tem de ser da MESMA organização.
--
-- ─── (2) As três tabelas da Clinicorp ────────────────────────────────────────
--
-- * `calendar_clinicorp_integrations`: uma por organização. A credencial ("Usuário
--   API" + "Token API", HTTP Basic) entra pela tela e o token é guardado cifrado
--   por `fn_encrypt_oauth`, como o segredo dos webhooks. Nunca volta ao
--   navegador. Também guarda a situação da última cópia.
-- * `calendar_clinicorp_professionals`: o profissional da Clinicorp
--   (`Dentist_PersonId`) e a pessoa da Agenda do CRM que ele é. Só o NOME do
--   profissional, nunca dado de paciente.
-- * `calendar_clinicorp_events`: a ocupação copiada. `unique (organization_id,
--   external_id)`, e a cópia só sobrescreve com uma versão igual ou mais nova
--   (`z_LastChange_Date`).
--
-- As três negam tudo a `anon` e `authenticated` (sem policy, privilégio
-- revogado). Quem escreve é a rota e o cron, com o service role, filtrando a
-- organização de fonte confiável. Membro nenhum lê a cópia crua; a ocupação
-- chega a ele pela função abaixo, que só devolve intervalos.
--
-- ─── (3) A ocupação EXTERNA, numa função nova ────────────────────────────────
--
-- `fn_agenda_ocupacao_externa_do_dono` = tudo o que
-- `fn_agenda_ocupacao_google_do_dono` (0260) devolve, LIDO DELA e sem mudança,
-- mais a ocupação da Clinicorp do dono, com uma coluna `fonte`. A função do
-- Google não é tocada: a agenda de quem vive do Google responde exatamente o
-- mesmo (medido em `tests/invariants/agenda-ocupacao-da-clinicorp.test.ts`).
-- Mesmo desenho de segurança da 0260: `security definer` só para atravessar a
-- RLS, pertencimento conferido no corpo, dono como filtro, cruzamento estrito
-- de intervalos, e nada além de ocupação.
--
-- `fn_agenda_conexoes_externas_do_dono` faz o mesmo com a situação das conexões
-- (`agendaExternaNuncaLida`): a Clinicorp mapeada para o dono e nunca copiada
-- avisa, como o Google nunca lido.
--
-- Por que função nova e não `create or replace` da 0260: a coluna `fonte` muda o
-- tipo de retorno, e o Postgres não troca tipo de retorno no lugar. Reaplicar o
-- baseline (que o `update.sh` faz) quebraria no bloco da 0260.

-- ─── (1) unidade no dia aberto ───────────────────────────────────────────────
alter table public.calendar_availability_exceptions
  add column if not exists unit_id uuid;

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_exceptions_unit_fk') then
    alter table public.calendar_availability_exceptions
      add constraint calendar_exceptions_unit_fk foreign key (organization_id, unit_id)
      references public.calendar_units (organization_id, id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_exceptions_unidade_so_no_dia_aberto') then
    alter table public.calendar_availability_exceptions
      add constraint calendar_exceptions_unidade_so_no_dia_aberto
      check (unit_id is null or not is_unavailable);
  end if;
end $c$;

comment on column public.calendar_availability_exceptions.unit_id is
  'Migration 0433: a unidade onde a pessoa atende no dia ABERTO (is_unavailable = false). O dia aberto substitui a jornada daquele dia, então lançar "dia em outra unidade" já fecha a unidade de sempre. null = sem unidade, como antes.';

-- ─── (2) Clinicorp ───────────────────────────────────────────────────────────
create table if not exists public.calendar_clinicorp_integrations (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  api_user text not null check (btrim(api_user) <> '' and length(api_user) <= 200),
  api_token_encrypted bytea not null,
  subscriber_id text check (subscriber_id is null or (btrim(subscriber_id) <> '' and length(subscriber_id) <= 200)),
  -- A cópia: quando deu certo pela última vez, e por que a última falhou (texto
  -- nosso, nunca a resposta da Clinicorp, que pode trazer dado de paciente).
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.calendar_clinicorp_integrations is
  'Migration 0433: a agenda da Clinicorp desta organização. api_token_encrypted é o "Token API" cifrado por fn_encrypt_oauth: entra pela tela e nunca volta ao navegador, a log nem à auditoria.';

create table if not exists public.calendar_clinicorp_professionals (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  professional_id text not null check (professional_id ~ '^[0-9]{1,30}$'),
  name text check (name is null or length(name) <= 200),
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, professional_id),
  constraint calendar_clinicorp_professionals_integracao_fk foreign key (organization_id)
    references public.calendar_clinicorp_integrations(organization_id) on delete cascade
);

comment on table public.calendar_clinicorp_professionals is
  'Migration 0433: profissional da Clinicorp (Dentist_PersonId) -> pessoa da Agenda do CRM (user_id). Sem user_id, a ocupação dele não conta para ninguém.';

create table if not exists public.calendar_clinicorp_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_id text not null check (external_id ~ '^[0-9]{1,30}$'),
  professional_id text not null check (professional_id ~ '^[0-9]{1,30}$'),
  clinic_id text check (clinic_id is null or clinic_id ~ '^[0-9]{1,30}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  external_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_clinicorp_events_periodo_valido check (ends_at > starts_at),
  constraint calendar_clinicorp_events_key unique (organization_id, external_id),
  constraint calendar_clinicorp_events_integracao_fk foreign key (organization_id)
    references public.calendar_clinicorp_integrations(organization_id) on delete cascade
);

create index if not exists calendar_clinicorp_events_ocupam_idx
  on public.calendar_clinicorp_events (organization_id, professional_id, starts_at)
  where status <> 'cancelled';

comment on table public.calendar_clinicorp_events is
  'Migration 0433: a ocupação copiada da Clinicorp. Só início, fim, profissional, clínica, situação e id externo: nome, telefone, e-mail e observação do paciente nunca entram.';

alter table public.calendar_clinicorp_integrations enable row level security;
alter table public.calendar_clinicorp_professionals enable row level security;
alter table public.calendar_clinicorp_events enable row level security;
revoke all on table public.calendar_clinicorp_integrations from anon, authenticated;
revoke all on table public.calendar_clinicorp_professionals from anon, authenticated;
revoke all on table public.calendar_clinicorp_events from anon, authenticated;
grant select, insert, update, delete on table public.calendar_clinicorp_integrations to service_role;
grant select, insert, update, delete on table public.calendar_clinicorp_professionals to service_role;
grant select, insert, update, delete on table public.calendar_clinicorp_events to service_role;

-- A gravação da cópia: um lote por chamada, idempotente por (organização, id).
-- O mesmo id duas vezes no lote fica com a versão mais nova. Uma versão MAIS
-- VELHA que a gravada não sobrescreve (resposta atrasada de uma cópia anterior).
-- O profissional visto pela primeira vez entra sem pessoa, para a tela mapear.
create or replace function public.fn_agenda_clinicorp_gravar(p_org uuid, p_itens jsonb)
returns integer
language sql
volatile
set search_path = public
as $$
  with itens as (
    select distinct on (x.external_id) x.*
      from jsonb_to_recordset(coalesce(p_itens, '[]'::jsonb)) as x(
        external_id text, professional_id text, clinic_id text,
        starts_at timestamptz, ends_at timestamptz, status text, external_updated_at timestamptz)
     order by x.external_id, x.external_updated_at desc nulls last
  ),
  profissionais as (
    insert into public.calendar_clinicorp_professionals (organization_id, professional_id)
    select distinct p_org, i.professional_id from itens i
    on conflict (organization_id, professional_id) do nothing
    returning 1
  ),
  gravados as (
    insert into public.calendar_clinicorp_events as e
      (organization_id, external_id, professional_id, clinic_id, starts_at, ends_at, status, external_updated_at)
    select p_org, i.external_id, i.professional_id, i.clinic_id, i.starts_at, i.ends_at, i.status, i.external_updated_at
      from itens i
    on conflict (organization_id, external_id) do update set
      professional_id = excluded.professional_id,
      clinic_id = excluded.clinic_id,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      status = excluded.status,
      external_updated_at = excluded.external_updated_at,
      updated_at = now()
    -- Só grava o que MUDOU (a contagem é o efeito real, e o cron só audita
    -- rodada com efeito), e nunca uma versão mais velha por cima da nova.
    where (e.professional_id, e.clinic_id, e.starts_at, e.ends_at, e.status)
          is distinct from
          (excluded.professional_id, excluded.clinic_id, excluded.starts_at, excluded.ends_at, excluded.status)
      and (e.external_updated_at is null
           or excluded.external_updated_at is null
           or excluded.external_updated_at >= e.external_updated_at)
    returning 1
  )
  -- `profissionais` roda mesmo sem ser lido: CTE que escreve sempre executa.
  select count(*)::integer from gravados;
$$;

revoke execute on function public.fn_agenda_clinicorp_gravar(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_agenda_clinicorp_gravar(uuid, jsonb) to service_role;

-- ─── (3) a ocupação externa do dono ──────────────────────────────────────────
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
     and o.ends_at > p_de;
$$;

create or replace function public.fn_agenda_conexoes_externas_do_dono(
  p_org uuid,
  p_owner uuid
)
returns table (
  status text,
  last_sync_at timestamptz,
  fonte text
)
language sql
stable
security definer
set search_path = public
as $$
  select g.status, g.last_sync_at, 'google'::text
    from public.fn_agenda_conexoes_google_do_dono(p_org, p_owner) g
  union all
  select case when i.last_sync_error is null then 'healthy' else 'error' end, i.last_sync_at, 'clinicorp'::text
    from public.calendar_clinicorp_integrations i
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and i.organization_id = p_org
     and exists (
       select 1 from public.calendar_clinicorp_professionals p
        where p.organization_id = i.organization_id and p.user_id = p_owner
     );
$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (CLAUDE.md).
revoke execute on function public.fn_agenda_ocupacao_externa_do_dono(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function public.fn_agenda_ocupacao_externa_do_dono(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
revoke execute on function public.fn_agenda_conexoes_externas_do_dono(uuid, uuid) from public, anon;
grant  execute on function public.fn_agenda_conexoes_externas_do_dono(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
