-- 0271 — Unidades, salas e duração operacional dos serviços da agenda.

create table if not exists public.calendar_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_locations_name_present check (btrim(name) <> ''),
  constraint calendar_locations_slug_present check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  unique (organization_id, id),
  unique (organization_id, slug)
);

create table if not exists public.calendar_rooms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid not null,
  name text not null,
  kind text not null default 'outro',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_rooms_name_present check (btrim(name) <> ''),
  constraint calendar_rooms_kind_check check (kind in ('consultorio','aplicacao','atendimento','outro')),
  constraint calendar_rooms_location_fk foreign key (organization_id, location_id)
    references public.calendar_locations(organization_id, id) on delete restrict,
  unique (organization_id, id),
  unique (organization_id, location_id, id),
  unique (organization_id, location_id, name)
);

alter table public.catalog_products add column if not exists duration_minutes integer;
alter table public.catalog_products drop constraint if exists catalog_products_duration_minutes_check;
alter table public.catalog_products add constraint catalog_products_duration_minutes_check
  check (duration_minutes is null or duration_minutes between 5 and 1440);
create unique index if not exists catalog_products_org_id_key
  on public.catalog_products(organization_id, id);

alter table public.calendar_event_types add column if not exists catalog_product_id uuid;
alter table public.calendar_event_types drop constraint if exists calendar_event_types_catalog_product_fk;
alter table public.calendar_event_types add constraint calendar_event_types_catalog_product_fk
  foreign key (organization_id, catalog_product_id)
  references public.catalog_products(organization_id, id) on delete set null (catalog_product_id);

alter table public.calendar_appointments add column if not exists location_id uuid;
alter table public.calendar_appointments add column if not exists room_id uuid;
alter table public.calendar_appointments add column if not exists scheduled_duration_minutes integer;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_location_fk;
alter table public.calendar_appointments add constraint calendar_appointments_location_fk
  foreign key (organization_id, location_id)
  references public.calendar_locations(organization_id, id) on delete restrict;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_room_fk;
alter table public.calendar_appointments add constraint calendar_appointments_room_fk
  foreign key (organization_id, location_id, room_id)
  references public.calendar_rooms(organization_id, location_id, id) on delete restrict;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_duration_snapshot_check;
alter table public.calendar_appointments add constraint calendar_appointments_duration_snapshot_check
  check (scheduled_duration_minutes is null or scheduled_duration_minutes between 5 and 1440);
alter table public.calendar_appointments drop constraint if exists calendar_appointments_room_requires_location;
alter table public.calendar_appointments add constraint calendar_appointments_room_requires_location
  check (room_id is null or location_id is not null);

create index if not exists calendar_rooms_location_active_idx
  on public.calendar_rooms(organization_id, location_id, name) where is_active;
create index if not exists calendar_appointments_room_period_idx
  on public.calendar_appointments(organization_id, room_id, starts_at)
  where room_id is not null and status in ('pending','confirmed');

alter table public.calendar_locations enable row level security;
alter table public.calendar_rooms enable row level security;
drop policy if exists calendar_locations_select on public.calendar_locations;
create policy calendar_locations_select on public.calendar_locations for select using (
  organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
);
drop policy if exists calendar_locations_write on public.calendar_locations;
create policy calendar_locations_write on public.calendar_locations using (
  public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'))
) with check (
  public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'))
);
drop policy if exists calendar_rooms_select on public.calendar_rooms;
create policy calendar_rooms_select on public.calendar_rooms for select using (
  organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
);
drop policy if exists calendar_rooms_write on public.calendar_rooms;
create policy calendar_rooms_write on public.calendar_rooms using (
  public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'))
) with check (
  public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'))
);

revoke all on public.calendar_locations, public.calendar_rooms from anon;
grant select,insert,update,delete on public.calendar_locations, public.calendar_rooms to authenticated;
grant all on public.calendar_locations, public.calendar_rooms to service_role;

drop trigger if exists trg_calendar_locations_updated_at on public.calendar_locations;
create trigger trg_calendar_locations_updated_at before update on public.calendar_locations
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_calendar_rooms_updated_at on public.calendar_rooms;
create trigger trg_calendar_rooms_updated_at before update on public.calendar_rooms
  for each row execute function public.fn_set_updated_at();

comment on column public.catalog_products.duration_minutes is
  'Duração operacional do serviço em minutos. NULL impede oferta automática pela agenda/IA.';
comment on column public.calendar_appointments.scheduled_duration_minutes is
  'Cópia da duração usada ao marcar; preserva o histórico quando o catálogo muda.';
