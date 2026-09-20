-- 0271 — Unidades, salas e duração operacional dos serviços da agenda.
create table if not exists public.calendar_units (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null, timezone text not null default 'America/Sao_Paulo', active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint calendar_units_name_present check (btrim(name)<>''), unique(organization_id,id), unique(organization_id,name)
);
create table if not exists public.calendar_rooms (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 unit_id uuid not null, name text not null, kind text not null, active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint calendar_rooms_name_present check (btrim(name)<>''),
 constraint calendar_rooms_kind_check check(kind in ('consultation','application')),
 constraint calendar_rooms_unit_fk foreign key(organization_id,unit_id) references public.calendar_units(organization_id,id) on delete restrict,
 unique(organization_id,id), unique(organization_id,unit_id,id), unique(organization_id,unit_id,name)
);
alter table public.catalog_products add column if not exists appointment_duration_minutes integer;
alter table public.catalog_products drop constraint if exists catalog_products_appointment_duration_check;
alter table public.catalog_products add constraint catalog_products_appointment_duration_check check(appointment_duration_minutes is null or appointment_duration_minutes between 5 and 1440);
create unique index if not exists catalog_products_org_id_key on public.catalog_products(organization_id,id);
alter table public.calendar_event_types add column if not exists catalog_product_id uuid;
alter table public.calendar_event_types add column if not exists required_room_kind text;
alter table public.calendar_event_types add column if not exists concurrency_key text;
alter table public.calendar_event_types drop constraint if exists calendar_event_types_catalog_product_fk;
alter table public.calendar_event_types add constraint calendar_event_types_catalog_product_fk foreign key(organization_id,catalog_product_id) references public.catalog_products(organization_id,id) on delete set null (catalog_product_id);
alter table public.calendar_event_types drop constraint if exists calendar_event_types_required_room_kind_check;
alter table public.calendar_event_types add constraint calendar_event_types_required_room_kind_check check(required_room_kind is null or required_room_kind in ('consultation','application'));
alter table public.calendar_appointments add column if not exists unit_id uuid;
alter table public.calendar_appointments add column if not exists room_id uuid;
alter table public.calendar_appointments add column if not exists duration_minutes_snapshot integer;
update public.calendar_appointments set duration_minutes_snapshot=greatest(5,least(1440,round(extract(epoch from (ends_at-starts_at))/60)::integer)) where duration_minutes_snapshot is null;
alter table public.calendar_appointments alter column duration_minutes_snapshot set not null;
create or replace function public.fn_calendar_appointment_duration_snapshot()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.duration_minutes_snapshot is null then
    new.duration_minutes_snapshot := greatest(5, least(1440, round(extract(epoch from (new.ends_at-new.starts_at))/60)::integer));
  end if;
  return new;
end;
$$;
revoke all on function public.fn_calendar_appointment_duration_snapshot() from public, anon, authenticated;
drop trigger if exists trg_calendar_appointment_duration_snapshot on public.calendar_appointments;
create trigger trg_calendar_appointment_duration_snapshot before insert on public.calendar_appointments for each row execute function public.fn_calendar_appointment_duration_snapshot();
alter table public.calendar_appointments drop constraint if exists calendar_appointments_unit_fk;
alter table public.calendar_appointments add constraint calendar_appointments_unit_fk foreign key(organization_id,unit_id) references public.calendar_units(organization_id,id) on delete restrict;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_room_fk;
alter table public.calendar_appointments add constraint calendar_appointments_room_fk foreign key(organization_id,unit_id,room_id) references public.calendar_rooms(organization_id,unit_id,id) on delete restrict;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_duration_snapshot_check;
alter table public.calendar_appointments add constraint calendar_appointments_duration_snapshot_check check(duration_minutes_snapshot between 5 and 1440);
alter table public.calendar_appointments drop constraint if exists calendar_appointments_room_requires_unit;
alter table public.calendar_appointments add constraint calendar_appointments_room_requires_unit check(room_id is null or unit_id is not null);
create index if not exists calendar_rooms_unit_active_idx on public.calendar_rooms(organization_id,unit_id,active);
create index if not exists calendar_appointments_room_period_idx on public.calendar_appointments(organization_id,room_id,starts_at) where room_id is not null and status in ('pending','confirmed');
alter table public.calendar_units enable row level security; alter table public.calendar_rooms enable row level security;
drop policy if exists calendar_units_select on public.calendar_units;
create policy calendar_units_select on public.calendar_units for select using(organization_id in(select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists calendar_units_write on public.calendar_units;
create policy calendar_units_write on public.calendar_units using(public.fn_is_platform_admin() or (organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'))) with check(public.fn_is_platform_admin() or (organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager')));
drop policy if exists calendar_rooms_select on public.calendar_rooms;
create policy calendar_rooms_select on public.calendar_rooms for select using(organization_id in(select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists calendar_rooms_write on public.calendar_rooms;
create policy calendar_rooms_write on public.calendar_rooms using(public.fn_is_platform_admin() or (organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'))) with check(public.fn_is_platform_admin() or (organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager')));
revoke all on public.calendar_units,public.calendar_rooms from anon;
grant select,insert,update,delete on public.calendar_units,public.calendar_rooms to authenticated;
grant all on public.calendar_units,public.calendar_rooms to service_role;
drop trigger if exists trg_calendar_units_updated_at on public.calendar_units;
create trigger trg_calendar_units_updated_at before update on public.calendar_units for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_calendar_rooms_updated_at on public.calendar_rooms;
create trigger trg_calendar_rooms_updated_at before update on public.calendar_rooms for each row execute function public.fn_set_updated_at();
comment on column public.catalog_products.appointment_duration_minutes is 'Duração operacional do serviço em minutos. NULL impede oferta automática pela agenda/IA.';
comment on column public.calendar_appointments.duration_minutes_snapshot is 'Cópia da duração usada ao marcar; preserva o histórico quando o catálogo muda.';
