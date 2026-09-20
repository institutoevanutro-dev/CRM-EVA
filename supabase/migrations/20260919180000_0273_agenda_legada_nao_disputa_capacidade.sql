-- 0273 — Compromissos anteriores ao catálogo de serviços não têm chave de capacidade.
create or replace function public.fn_calendar_allocate_and_guard_resources()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room_kind text;
  v_concurrency_key text;
  v_existing record;
begin
  if new.status not in ('pending', 'confirmed') then return new; end if;

  select required_room_kind, concurrency_key
    into v_room_kind, v_concurrency_key
    from public.calendar_event_types
   where id = new.event_type_id and organization_id = new.organization_id;

  if new.owner_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':owner:' || new.owner_user_id::text, 0));
  end if;

  if v_room_kind is not null then
    if new.unit_id is null then
      raise exception 'agenda_unidade_obrigatoria' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':unit:' || new.unit_id::text, 0));

    if new.room_id is null then
      select r.id into new.room_id
        from public.calendar_rooms r
       where r.organization_id = new.organization_id
         and r.unit_id = new.unit_id
         and r.kind = v_room_kind
         and r.active
         and not exists (
           select 1 from public.calendar_appointments a
            where a.organization_id = new.organization_id
              and a.room_id = r.id
              and a.status in ('pending','confirmed')
              and a.id is distinct from new.id
              and a.starts_at < new.ends_at and a.ends_at > new.starts_at
         )
       order by r.id
       limit 1;
      if new.room_id is null then
        raise exception 'agenda_sem_sala_compativel' using errcode = 'P0001';
      end if;
    end if;

    if not exists (
      select 1 from public.calendar_rooms r
       where r.id = new.room_id and r.organization_id = new.organization_id
         and r.unit_id = new.unit_id and r.kind = v_room_kind and r.active
    ) then
      raise exception 'agenda_sala_incompativel' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.calendar_appointments a
       where a.organization_id = new.organization_id and a.room_id = new.room_id
         and a.status in ('pending','confirmed') and a.id is distinct from new.id
         and a.starts_at < new.ends_at and a.ends_at > new.starts_at
    ) then
      raise exception 'agenda_sala_ocupada' using errcode = 'P0001';
    end if;
  end if;

  -- Linhas sem tipo são anteriores à configuração de serviços e não informam
  -- unidade, sala ou chave de simultaneidade. Elas continuam válidas, mas não
  -- participam da decisão nova de capacidade do profissional.
  if new.owner_user_id is not null and new.event_type_id is not null then
    for v_existing in
      select a.unit_id, t.concurrency_key
        from public.calendar_appointments a
        join public.calendar_event_types t
          on t.id = a.event_type_id and t.organization_id = a.organization_id
       where a.organization_id = new.organization_id
         and a.owner_user_id = new.owner_user_id
         and a.event_type_id is not null
         and a.status in ('pending','confirmed')
         and a.id is distinct from new.id
         and a.starts_at < new.ends_at and a.ends_at > new.starts_at
    loop
      if new.unit_id is null
         or v_existing.unit_id is distinct from new.unit_id
         or v_concurrency_key is null
         or v_existing.concurrency_key is null
         or v_existing.concurrency_key = v_concurrency_key then
        raise exception 'agenda_capacidade_excedida' using errcode = 'P0001';
      end if;
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function public.fn_calendar_allocate_and_guard_resources() from public, anon, authenticated;
grant execute on function public.fn_calendar_allocate_and_guard_resources() to service_role;
