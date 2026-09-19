-- 0267 — T60 elegível antes do limite, decisão serializada e histórico preservado.
-- A resolução humana também conta como tratada; não reabrir a mesma reserva.
create or replace function public.sinal_reservas_elegiveis(p_agora timestamptz)
returns table (id uuid, organization_id uuid, contact_id uuid, criada_em timestamptz, consulta_em timestamptz)
language sql stable security invoker set search_path = public as $$
  select a.id, a.organization_id, a.contact_id, a.created_at, a.starts_at
  from public.calendar_appointments a
  join public.calendar_event_types t on t.id = a.event_type_id and t.organization_id = a.organization_id
  join public.contacts c on c.id = a.contact_id and c.organization_id = a.organization_id
  where a.status in ('pending', 'confirmed') and t.requires_signal and not c.is_anonymized
    and least(a.created_at + interval '60 minutes', a.starts_at) <= p_agora
    and not exists (
      select 1 from public.crm_leads l join public.crm_stages s
        on s.id = l.stage_id and s.organization_id = l.organization_id
      where l.organization_id = a.organization_id and l.contact_id = a.contact_id
        and l.status = 'open' and s.blocks_followups
    )
    and not exists (
      select 1 from public.agent_inbox_items i
      where i.organization_id = a.organization_id and i.kind = 'sinal_revisao_humana'
        and i.ref_kind in ('appointment', 'calendar_appointment') and i.ref_id = a.id
    )
$$;
revoke execute on function public.sinal_reservas_elegiveis(timestamptz) from public, anon, authenticated;
grant execute on function public.sinal_reservas_elegiveis(timestamptz) to service_role;

create or replace function public.sinal_listar_revisoes(p_agora timestamptz, p_limite integer)
returns table (id uuid, organization_id uuid, contact_id uuid, criada_em timestamptz, consulta_em timestamptz)
language sql stable security invoker set search_path = public as $$
  select * from public.sinal_reservas_elegiveis(p_agora)
  order by criada_em, id limit greatest(0, least(p_limite, 500))
$$;
revoke execute on function public.sinal_listar_revisoes(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.sinal_listar_revisoes(timestamptz, integer) to service_role;

create or replace function public.sinal_abrir_revisao(p_organization_id uuid, p_appointment_id uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
declare v_contact_id uuid; v_inserted uuid;
begin
  select a.contact_id into v_contact_id from public.calendar_appointments a
    where a.organization_id = p_organization_id and a.id = p_appointment_id;
  if v_contact_id is null then return false; end if;
  -- Mesmo mutex da mesclagem/recuperação, antes de qualquer row lock.
  perform public.fn_service_lock(p_organization_id, v_contact_id);
  -- FOR UPDATE também bloqueia novas FKs de negócios para este contato.
  perform c.id from public.contacts c where c.organization_id = p_organization_id and c.id = v_contact_id for update;
  perform a.id from public.calendar_appointments a
    where a.organization_id = p_organization_id and a.id = p_appointment_id and a.contact_id = v_contact_id for update;
  if not found then return false; end if;
  perform t.id from public.calendar_event_types t join public.calendar_appointments a
    on a.event_type_id = t.id and a.organization_id = t.organization_id
    where a.organization_id = p_organization_id and a.id = p_appointment_id for update of t;
  perform l.id from public.crm_leads l
    where l.organization_id = p_organization_id and l.contact_id = v_contact_id order by l.id for update;
  perform s.id from public.crm_stages s join public.crm_leads l
    on s.id = l.stage_id and s.organization_id = l.organization_id
    where l.organization_id = p_organization_id and l.contact_id = v_contact_id order by s.id for update of s;
  -- Nova leitura DEPOIS dos locks: reentrega concorrente já vê o item commitado.
  insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
  select p_organization_id, 'sinal_revisao_humana', 'warn', 'Sinal não confirmado — revisão humana',
    'A reserva passou do prazo (T+60 da criação, ou início da consulta) sem comprovante tratado. Nenhuma ação automática foi tomada: o horário não foi liberado, a consulta não foi cancelada e falta não foi marcada.',
    'appointment', p_appointment_id
  from public.sinal_reservas_elegiveis(clock_timestamp()) e
  where e.organization_id = p_organization_id and e.id = p_appointment_id
  returning id into v_inserted;
  return v_inserted is not null;
end;
$$;
revoke execute on function public.sinal_abrir_revisao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sinal_abrir_revisao(uuid, uuid) to service_role;

-- appointment_id já existia para appointment_no_show (0224). A FK SET NULL
-- não pode transformar uma inscrição vinculada em fluxo genérico liberado.
-- Cancela só inscrições vivas cuja reserva efetivamente desapareceu/desvinculou.
create or replace function public.followup_reserva_desvinculada()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if old.appointment_revision is null and old.appointment_id is not null and new.appointment_id is null
     and new.status in ('active', 'waiting_reply', 'paused_handoff', 'paused_manual') then
    new.status := 'cancelled';
    new.cancel_reason := 'Reserva desvinculada ou excluída; sequência encerrada.';
    new.next_eval_at := null;
    new.claimed_until := null;
    new.completed_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function public.followup_reserva_desvinculada() from public, anon, authenticated;
grant execute on function public.followup_reserva_desvinculada() to service_role;
drop trigger if exists trg_followup_reserva_desvinculada on public.followup_enrollments;
create trigger trg_followup_reserva_desvinculada before update of appointment_id on public.followup_enrollments
  for each row execute function public.followup_reserva_desvinculada();
