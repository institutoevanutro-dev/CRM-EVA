-- Migration 0411 : TIPO DE COMPROMISSO QUE É CONSULTA EXIGE PACIENTE.
--
-- Incidente de 12/11: a recepção marcou "Primeira consulta" pela Agenda sem
-- escolher o paciente (o POST aceitava `contact_id` ausente) e o Prontuário
-- abriu o compromisso como "Paciente não informado".
--
-- `calendar_event_types.requires_patient` (novo, default true): com true, a
-- criação de compromisso deste tipo é recusada sem `contact_id`
-- (422 `patient_required`, em `marcarAgendamentoHandler`, que serve à tela, à
-- REST e à ferramenta da IA). Reunião interna desliga em Configurações › Agenda.
-- Bloqueio de horário não é tipo de compromisso (`calendar_availability_exceptions`,
-- aba "Bloquear horário") e não passa por esta regra.
--
-- Reunião: o tipo semeado "Reunião" (categoria `reuniao`) nasce sem exigir
-- paciente, nas organizações novas (`fn_semear_tipos_de_agendamento`) e, uma vez
-- só, na criação da coluna para as que já existem. Reaplicar não desfaz quem
-- religou o interruptor.
--
-- No baseline: a coluna num bloco ANTES do backfill da 0185 (que chama a função
-- de semente) e a função trocada no lugar. Nenhum GRANT (os da tabela valem para
-- a coluna). Idempotente.

do $$
begin
  -- Só na criação da coluna: o tipo semeado "Reunião" (categoria `reuniao`)
  -- é reunião interna e continua sem paciente. Reaplicar não desfaz quem
  -- religou o interruptor depois.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'calendar_event_types'
       and column_name = 'requires_patient'
  ) then
    alter table public.calendar_event_types
      add column requires_patient boolean not null default true;
    update public.calendar_event_types set requires_patient = false where category = 'reuniao';
  end if;
end $$;

comment on column public.calendar_event_types.requires_patient is
  'Compromisso deste tipo só nasce com paciente (contact_id). Desligue para reunião interna. Migration 0411.';

create or replace function public.fn_semear_tipos_de_agendamento(p_organization_id uuid)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_criados integer := 0;
  r record;
begin
  for r in
    select * from (values
      ('Consulta',    'consulta',    'consulta', 30, 1000::numeric),
      ('Reunião',     'reuniao',     'reuniao',  30, 2000::numeric),
      ('Atendimento', 'atendimento', 'outro',    30, 3000::numeric)
    ) as t(nome, slug, categoria, duracao, posicao)
  loop
    insert into public.calendar_event_types
      (organization_id, name, slug, category, duration_minutes, position, requires_patient)
    values
      (p_organization_id, r.nome, r.slug, r.categoria, r.duracao, r.posicao, r.categoria <> 'reuniao')
    on conflict (organization_id, slug) do nothing;

    if found then
      v_criados := v_criados + 1;
    end if;
  end loop;

  return v_criados;
end;
$$;

revoke execute on function public.fn_semear_tipos_de_agendamento(uuid) from public, anon, authenticated;
grant  execute on function public.fn_semear_tipos_de_agendamento(uuid) to service_role;
