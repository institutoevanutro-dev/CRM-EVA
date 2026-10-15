-- Migration 0364 : EXCLUIR UM AGENDAMENTO LANÇADO POR ENGANO OU DE TESTE.
--
-- ---- excluir agendamento lançado por engano (migration 0364) ----
-- Decisão do dono do produto: o compromisso marcado por engano, ou de teste,
-- some da Agenda (grade, listas, visão do contato e do negócio, ferramentas da
-- IA, horários livres, contagens e relatórios), mas a LINHA FICA no banco para
-- auditoria, com quem excluiu, quando e por quê. Não é anonimização (LGPD) e não
-- é DELETE: apagar a linha perderia o rastro, que é o anti-pattern "cascade
-- fantasma" do CLAUDE.md.
--
-- Excluir é CANCELAR + MARCAR. O cancelamento passa pelo mesmo núcleo do
-- cancelar (`fn_appointment_change_core`): o evento do Google sai pelo mesmo
-- caminho (a revisão publicável muda), o horário volta a ficar livre
-- (`cancelled` está em LIBERAM_O_HORARIO), os follow-ups presos ao compromisso
-- e os avisos da Central fecham. O que a exclusão NÃO faz é o que o handler
-- deixa de fazer: emitir `appointment.cancelled` para o motor de regras, que
-- avisaria o paciente de um cancelamento que nunca existiu.
--
-- Invariantes, todas no banco:
--   * `calendar_appointments_exclusao_coerente`: excluído é sempre cancelado e
--     sempre tem motivo. Toda leitura que já ignora `cancelled` (horários livres,
--     lembretes, contexto da IA, proteção de follow-up) ignora o excluído sem
--     filtro novo; só as leituras que MOSTRAM cancelado precisam de
--     `excluded_at is null`.
--   * `fn_appointment_exclusion_guard`: só gerente ou admin marca (inclusive por
--     UPDATE direto na REST, que a policy de update deixa ao `agent`), quem e
--     quando vêm da sessão e do relógio, nunca do corpo, e a marca é final.
--   * `fn_appointment_exclude`: a porta da tela. Idempotente: excluir de novo
--     devolve a mesma linha.

alter table public.calendar_appointments add column if not exists excluded_at timestamptz;
alter table public.calendar_appointments add column if not exists excluded_by_user_id uuid references auth.users(id) on delete set null;
alter table public.calendar_appointments add column if not exists exclusion_reason text;

alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_exclusao_coerente,
  add constraint calendar_appointments_exclusao_coerente check (
    (excluded_at is null and exclusion_reason is null and excluded_by_user_id is null)
    or (excluded_at is not null and status = 'cancelled' and length(btrim(exclusion_reason)) >= 3)
  );

comment on column public.calendar_appointments.excluded_at is
  'Excluído por engano ou teste (migration 0364). A linha fica para auditoria; toda tela, relatório e ferramenta da IA a ignora.';

create or replace function public.fn_appointment_exclusion_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.excluded_at is not null then
    -- A marca é final. `excluded_by_user_id` pode ir a null sozinho: é o
    -- `on delete set null` da FK quando a pessoa sai de auth.users.
    if row(new.excluded_at, new.exclusion_reason) is distinct from row(old.excluded_at, old.exclusion_reason)
       or (new.excluded_by_user_id is not null and new.excluded_by_user_id is distinct from old.excluded_by_user_id) then
      raise exception 'appointment_exclusion_final' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.excluded_at is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'appointment_exclusion_on_insert' using errcode = '42501';
  end if;
  if auth.uid() is not null and not (
    public.fn_role_at_least(new.organization_id, 'manager')
    and public.fn_support_write_allowed(new.organization_id)
    and public.fn_session_mfa_proven()
  ) then
    raise exception 'appointment_exclusion_forbidden' using errcode = '42501';
  end if;
  new.excluded_at := now();
  new.excluded_by_user_id := auth.uid();
  new.exclusion_reason := btrim(new.exclusion_reason);
  return new;
end $$;
revoke all on function public.fn_appointment_exclusion_guard() from public, anon, authenticated;

create or replace trigger trg_appointment_exclusion_guard
  before insert or update on public.calendar_appointments
  for each row execute function public.fn_appointment_exclusion_guard();

create or replace function public.fn_appointment_exclude(p_org uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.calendar_appointments;
begin
  -- O papel ANTES de olhar a linha: definer não tem RLS, e devolver a linha
  -- (ou um "não existe") a quem não é gerente desta organização seria vazar.
  if auth.uid() is not null and not (
    public.fn_role_at_least(p_org, 'manager')
    and public.fn_support_write_allowed(p_org)
    and public.fn_session_mfa_proven()
  ) then
    raise exception 'appointment_exclusion_forbidden' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'appointment_exclusion_reason_required' using errcode = '22023';
  end if;
  select * into a from public.calendar_appointments where organization_id = p_org and id = p_id;
  if not found then
    raise exception 'appointment_not_found' using errcode = 'P0002';
  end if;
  if a.excluded_at is not null then
    return to_jsonb(a);
  end if;
  if a.status <> 'cancelled' then
    perform public.fn_appointment_change_core(p_org, p_id, a.revision,
      jsonb_build_object('status', 'cancelled', 'cancellation_reason', btrim(p_reason)), false, null);
  end if;
  update public.calendar_appointments
     set excluded_at = now(), exclusion_reason = p_reason
   where organization_id = p_org and id = p_id and excluded_at is null
  returning * into a;
  if not found then
    select * into a from public.calendar_appointments where organization_id = p_org and id = p_id;
  end if;
  return to_jsonb(a);
end $$;

do $janela$ begin
  revoke all on function public.fn_appointment_exclude(uuid, uuid, text) from public, anon;
  grant execute on function public.fn_appointment_exclude(uuid, uuid, text) to authenticated, service_role;
end $janela$;

-- O painel de Início não conta o que foi lançado por engano.
create or replace function public.fn_inicio_agenda(p_org uuid, p_inicio timestamptz, p_fim timestamptz)
returns table(unit_id uuid, unidade text, marcadas int, confirmadas int, realizadas int, faltas int, canceladas int)
language sql stable
set search_path = public
as $$
  select a.unit_id, u.name,
         (count(*) filter (where a.status <> 'cancelled'))::int,
         (count(*) filter (where a.status = 'confirmed'))::int,
         (count(*) filter (where a.status = 'completed'))::int,
         (count(*) filter (where a.status = 'no_show'))::int,
         (count(*) filter (where a.status = 'cancelled'))::int
    from public.calendar_appointments a
    left join public.calendar_units u on u.id = a.unit_id and u.organization_id = p_org
   where a.organization_id = p_org and a.starts_at >= p_inicio and a.starts_at < p_fim
     and a.excluded_at is null
   group by a.unit_id, u.name
   order by u.name nulls last;
$$;
-- ---- fim: excluir agendamento lançado por engano (migration 0364) ----
