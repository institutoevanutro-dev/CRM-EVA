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
