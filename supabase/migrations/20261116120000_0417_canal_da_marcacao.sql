-- Migration 0417 : CANAL DA MARCAÇÃO DA CONSULTA (bônus por comparecimento).
--
-- Decisão do dono (16/11): o bônus da equipe passa a ser por consulta em que o
-- paciente COMPARECEU, e vale R$ X se a consulta foi marcada por mensagem e
-- R$ Y se foi marcada por ligação (valores em `bonus_programas.regras`, bloco
-- `comparecimentos`). A atendente escolhe o canal ao marcar pela Agenda.
--
-- `calendar_appointments.booking_channel`: 'mensagem' | 'ligacao'. NULA =
-- compromisso legado (antes desta coluna) ou marcado pela IA/integração. O
-- cálculo do bônus conta legado de pessoa como 'mensagem' e ignora o que não
-- foi marcado por pessoa (`created_by_kind <> 'user'`).
--
-- CHECK de conjunto, sem dado legado a corrigir (a coluna nasce nula). Par no
-- TypeScript: `CANAIS_DA_MARCACAO` em `lib/agenda/tipos.ts`, vigiado por
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
--
-- Nenhuma função nova; nenhum GRANT (os da tabela valem para a coluna).
-- Idempotente. Mesmo bloco no apêndice do `supabase/baseline.sql`.

alter table public.calendar_appointments
  add column if not exists booking_channel text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_appointments_booking_channel_check'
       and conrelid = 'public.calendar_appointments'::regclass
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_booking_channel_check
      check (booking_channel in ('mensagem', 'ligacao'));
  end if;
end $$;

comment on column public.calendar_appointments.booking_channel is
  'Como a equipe marcou a consulta: mensagem ou ligacao. Nula = legado ou marcada pela IA. Base do bônus por comparecimento. Migration 0417.';
