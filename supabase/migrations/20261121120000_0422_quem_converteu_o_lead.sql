-- Migration 0422 : QUEM CONVERTEU O LEAD, GRAVADO NO AGENDAMENTO.
--
-- Pedido do dono da clínica (21/11/2026): o "Novo agendamento" passa a dizer
-- quem fez a conversão do lead — uma pessoa da equipe ou a IA do atendimento —,
-- que nem sempre é quem clicou em Confirmar (`created_by_user_id`): a
-- recepcionista que conversou com o paciente pode não ser quem marcou.
--
-- `calendar_appointments.converted_by_kind`: 'user' | 'ai'.
-- `calendar_appointments.converted_by_user_id`: a pessoa, quando 'user'.
-- NULAS = compromisso de antes desta coluna, ou marcado por integração. SEM
-- backfill, de propósito (o precedente é a 0101): copiar `created_by_*` para as
-- linhas antigas afirmaria uma conversão que ninguém informou.
--
-- Duas CHECKs: o conjunto do tipo, e a coerência (IA não tem pessoa). Par no
-- TypeScript: `QUEM_CONVERTEU` em `lib/agenda/tipos.ts`, vigiado por
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
--
-- A FK é a mesma de `created_by_user_id` (auth.users, on delete set null): quem
-- sai da equipe não apaga o histórico. A rota que marca confere que a pessoa é
-- da organização (`_handler.ts`), porque o id vem do corpo do pedido.
--
-- Nenhuma função nova; nenhum GRANT (os da tabela valem para as colunas).
-- Idempotente. Mesmo bloco no apêndice do `supabase/baseline.sql`.

alter table public.calendar_appointments
  add column if not exists converted_by_kind text;

alter table public.calendar_appointments
  add column if not exists converted_by_user_id uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_appointments_converted_by_kind_check'
       and conrelid = 'public.calendar_appointments'::regclass
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_converted_by_kind_check
      check (converted_by_kind in ('user', 'ai'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_appointments_converted_by_coerente'
       and conrelid = 'public.calendar_appointments'::regclass
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_converted_by_coerente
      check (converted_by_kind is distinct from 'ai' or converted_by_user_id is null);
  end if;
end $$;

comment on column public.calendar_appointments.converted_by_kind is
  'Quem converteu o lead neste agendamento: user (pessoa da equipe) ou ai (IA do atendimento). Nula = legado ou integração. Migration 0422.';
comment on column public.calendar_appointments.converted_by_user_id is
  'A pessoa que converteu o lead, quando converted_by_kind = user. Migration 0422.';
