-- Migration 0392 : BÔNUS DA EQUIPE (Etapa 1).
--
-- Um programa de bônus por organização. A REGRA (participantes, valores, faixas,
-- metas, rotinas e limites da fila) é um jsonb lido e escrito por UM esquema Zod,
-- `lib/bonus/regras.ts`, e só o APROVADOR gravado na linha lê ou escreve. O papel
-- no tenant não decide nada aqui: quem participa do programa costuma ser admin.
--
-- Partes:
--   1. tarefas: hora de encerramento (`closed_at`) e prazo trocado depois de
--      vencido (`missed_due_date`), pelo gatilho — vale para tela, MCP e IA;
--   2. as três tabelas do programa, com RLS só de leitura (toda escrita é rota
--      com service role e filtro de organização);
--   3. `fn_bonus_montar_fila`, que monta a fila do dia (só service_role);
--   4. LGPD: anonimizar o contato apaga o resumo das ligações dele.
--
-- Idempotente; portável em psql puro; sem BEGIN/COMMIT.

-- ---- 1. tarefas: encerramento e prazo trocado depois de vencido ----
alter table public.crm_tasks
  add column if not exists closed_at timestamptz,
  add column if not exists missed_due_date timestamptz;

comment on column public.crm_tasks.closed_at is
  'Quando a tarefa foi ENCERRADA (done ou cancelled). Gravado só pelo gatilho trg_crm_tasks_encerramento_e_prazo; reabrir apaga.';
comment on column public.crm_tasks.missed_due_date is
  'O prazo que já tinha VENCIDO (fim do dia local passou) quando alguém o trocou. Nunca apagado: a tarefa conta como atrasada.';

-- Aproximação para o que já estava encerrado antes desta migration: updated_at é
-- o melhor rastro que existe. Roda ANTES de o gatilho nascer, que senão manteria
-- o closed_at antigo (nulo). Reaplicar não acha linha: o gatilho grava sempre.
-- Efeito colateral aceito: o UPDATE dispara trg_crm_tasks_updated_at, e o
-- updated_at das tarefas já encerradas passa a ser a hora do deploy.
update public.crm_tasks
   set closed_at = updated_at
 where status in ('done', 'cancelled')
   and closed_at is null;

create or replace function public.fn_crm_tasks_encerramento_e_prazo()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_encerrada_agora boolean := new.status in ('done', 'cancelled');
  v_encerrada_antes boolean;
  v_fuso text;
begin
  if tg_op = 'INSERT' then
    new.closed_at := case when v_encerrada_agora then now() end;
    new.missed_due_date := null;
    return new;
  end if;

  v_encerrada_antes := old.status in ('done', 'cancelled');
  if v_encerrada_agora and not v_encerrada_antes then
    new.closed_at := now();
  elsif v_encerrada_agora then
    new.closed_at := old.closed_at;
  else
    new.closed_at := null;
  end if;

  -- A marca nunca é apagada nem forjada por quem edita.
  new.missed_due_date := old.missed_due_date;
  if new.missed_due_date is null
     and old.due_date is not null
     and new.due_date is distinct from old.due_date
     and not v_encerrada_antes then
    select coalesce(nullif(btrim(o.timezone), ''), 'America/Sao_Paulo')
      into v_fuso
      from public.organizations o
     where o.id = old.organization_id;
    -- A coluna não é validada (ver lib/agent-engine/agent/fuso-da-org.ts): um
    -- nome fora do IANA faria o `at time zone` lançar e derrubar a troca de prazo.
    if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_fuso) then
      v_fuso := 'America/Sao_Paulo';
    end if;
    -- Vencido = o FIM DO DIA LOCAL do prazo já passou (a regra do bônus é
    -- "concluída até o fim do dia do prazo"). Trocar no próprio dia não conta.
    if ((((old.due_date at time zone v_fuso)::date + 1)::timestamp) at time zone v_fuso) <= now() then
      new.missed_due_date := old.due_date;
    end if;
  end if;
  return new;
end$$;

revoke all on function public.fn_crm_tasks_encerramento_e_prazo() from public, anon, authenticated;

create or replace trigger trg_crm_tasks_encerramento_e_prazo
  before insert or update on public.crm_tasks
  for each row execute function public.fn_crm_tasks_encerramento_e_prazo();

-- ---- 2. as três tabelas do programa ----
create table if not exists public.bonus_programas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `restrict`: o programa nunca fica sem aprovador. Para tirar a pessoa da
  -- instalação, o aprovador passa a função antes (tela de Configuração).
  aprovador_user_id uuid not null references auth.users(id) on delete restrict,
  ativo boolean not null default true,
  -- Esquema ÚNICO em lib/bonus/regras.ts (Zod). A tela nunca lê path direto.
  regras jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bonus_programas_uma_por_org unique (organization_id)
);

create or replace trigger trg_bonus_programas_updated_at
  before update on public.bonus_programas
  for each row execute function public.fn_set_updated_at();

create table if not exists public.bonus_fila_itens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  dia date not null,
  tipo text not null,
  -- `cascade`, de propósito: tirar a pessoa da instalação apaga o histórico
  -- dela na fila. Quem não pode sumir é o aprovador (`restrict`, no programa).
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  motivo text,
  ligacao_resultado text,
  ligacao_resumo text,
  ligacao_registrada_em timestamptz,
  created_at timestamptz not null default now(),
  constraint bonus_fila_itens_tipo_check check (tipo in ('lead_antigo', 'ligacao')),
  constraint bonus_fila_itens_motivo_check check (motivo is null or motivo in ('faltou', 'sem_retorno', 'pos_consulta')),
  constraint bonus_fila_itens_resultado_check check (ligacao_resultado is null or ligacao_resultado in ('atendeu', 'nao_atendeu')),
  constraint bonus_fila_itens_ligacao_coerente check ((ligacao_resultado is null) = (ligacao_registrada_em is null)),
  constraint bonus_fila_itens_resumo_curto check (ligacao_resumo is null or length(ligacao_resumo) <= 500),
  -- Um contato, uma pessoa, um dia: a dupla nunca liga duas vezes para o mesmo.
  constraint bonus_fila_itens_um_por_dia unique (organization_id, dia, tipo, contact_id)
);

create index if not exists bonus_fila_itens_pessoa_dia_idx
  on public.bonus_fila_itens (organization_id, user_id, dia);
create index if not exists bonus_fila_itens_contato_idx
  on public.bonus_fila_itens (organization_id, contact_id, tipo, dia desc);

create table if not exists public.bonus_stories_dia (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  dia date not null,
  -- ids dos stories vistos no dia LOCAL. O story some em 24h; o cron de hora em
  -- hora junta os ids, e a contagem é o tamanho da lista.
  story_ids text[] not null default '{}',
  -- Lançado à mão pelo aprovador; quando presente, vence a leitura automática.
  contagem_manual integer,
  lancado_por uuid references auth.users(id) on delete set null,
  leitura_erro text,
  lido_em timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, dia),
  constraint bonus_stories_dia_contagem_check check (contagem_manual is null or contagem_manual between 0 and 50)
);

alter table public.bonus_programas enable row level security;
alter table public.bonus_fila_itens enable row level security;
alter table public.bonus_stories_dia enable row level security;

do $politica$ begin -- só recria quando a definição no banco não é esta (reaplicar-o-baseline-nao-abre-janela.test.ts)
if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bonus_programas' and policyname = 'bonus_programas_select_aprovador'
    and md5(concat_ws('|', permissive, cmd, roles::text, coalesce(qual, '~'), coalesce(with_check, '~'))) = '4d48ad2150662c0a7c708c32201c9afb') then
drop policy if exists bonus_programas_select_aprovador on public.bonus_programas;
create policy bonus_programas_select_aprovador on public.bonus_programas
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and aprovador_user_id = (select auth.uid())
  );
end if;
end $politica$;

do $politica$ begin -- só recria quando a definição no banco não é esta (reaplicar-o-baseline-nao-abre-janela.test.ts)
if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bonus_fila_itens' and policyname = 'bonus_fila_itens_select_dono_ou_aprovador'
    and md5(concat_ws('|', permissive, cmd, roles::text, coalesce(qual, '~'), coalesce(with_check, '~'))) = '4adc3335f5491380ed8996c6797ca11c') then
drop policy if exists bonus_fila_itens_select_dono_ou_aprovador on public.bonus_fila_itens;
create policy bonus_fila_itens_select_dono_ou_aprovador on public.bonus_fila_itens
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and (user_id = (select auth.uid())
         or exists (select 1 from public.bonus_programas p
                     where p.organization_id = bonus_fila_itens.organization_id
                       and p.aprovador_user_id = (select auth.uid())))
  );
end if;
end $politica$;

do $politica$ begin -- só recria quando a definição no banco não é esta (reaplicar-o-baseline-nao-abre-janela.test.ts)
if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bonus_stories_dia' and policyname = 'tenant_isolation_bonus_stories_dia_select'
    and md5(concat_ws('|', permissive, cmd, roles::text, coalesce(qual, '~'), coalesce(with_check, '~'))) = '09d682226978b5d533d1ce157ece22a5') then
drop policy if exists tenant_isolation_bonus_stories_dia_select on public.bonus_stories_dia;
create policy tenant_isolation_bonus_stories_dia_select on public.bonus_stories_dia
  for select to authenticated using (organization_id in (select public.fn_user_org_ids()));
end if;
end $politica$;

-- No Supabase real o default ACL dá TUDO a anon e authenticated em tabela nova
-- (lição da 0258): revoga tudo e devolve só a leitura, no MESMO comando.
do $janela$ begin -- atômico: reaplicar não abre janela (reaplicar-o-baseline-nao-abre-janela.test.ts)
revoke all on public.bonus_programas, public.bonus_fila_itens, public.bonus_stories_dia from anon, authenticated;
grant select on public.bonus_programas, public.bonus_fila_itens, public.bonus_stories_dia to authenticated;
grant all on public.bonus_programas, public.bonus_fila_itens, public.bonus_stories_dia to service_role;
end $janela$;

-- ---- 4. LGPD: anonimizar apaga o resumo das ligações ----
-- Gatilho no FATO (`is_anonymized` virou true), como a 0184/0198: cobre o
-- cascade, a rota direta e quem anonimizar por outro caminho amanhã. O
-- resultado e a hora ficam (não são dado do titular, e a rotina do dia não muda).
create or replace function public.fn_bonus_redigir_ligacoes_de_contato_anonimizado()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  update public.bonus_fila_itens
     set ligacao_resumo = null
   where organization_id = new.organization_id
     and contact_id = new.id
     and ligacao_resumo is not null;
  return new;
end$$;

revoke all on function public.fn_bonus_redigir_ligacoes_de_contato_anonimizado() from public, anon, authenticated;

create or replace trigger trg_contacts_anonimizado_redige_ligacoes_do_bonus
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_bonus_redigir_ligacoes_de_contato_anonimizado();
