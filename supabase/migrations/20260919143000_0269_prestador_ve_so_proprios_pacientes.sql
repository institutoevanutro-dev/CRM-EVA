-- O prestador trabalha somente na propria agenda e nos pacientes vinculados.
-- Colaborador, gerente e administrador preservam a visao da organizacao.

alter table public.calendar_appointments enable row level security;
drop policy if exists tenant_isolation_calendar_appointments_all on public.calendar_appointments;
drop policy if exists calendar_appointments_select on public.calendar_appointments;
drop policy if exists calendar_appointments_write on public.calendar_appointments;
drop policy if exists calendar_appointments_insert on public.calendar_appointments;
drop policy if exists calendar_appointments_update on public.calendar_appointments;
drop policy if exists calendar_appointments_delete on public.calendar_appointments;

create policy calendar_appointments_select on public.calendar_appointments
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_user_role_in_org(organization_id) <> 'provider'
        or owner_user_id = auth.uid()
      )
    )
  );

create policy calendar_appointments_insert on public.calendar_appointments
  for insert with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (public.fn_user_role_in_org(organization_id) = 'provider' and owner_user_id = auth.uid())
        or public.fn_role_at_least(organization_id, 'agent')
      )
    )
  );

create policy calendar_appointments_update on public.calendar_appointments
  for update using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (public.fn_user_role_in_org(organization_id) = 'provider' and owner_user_id = auth.uid())
        or public.fn_role_at_least(organization_id, 'agent')
      )
    )
  ) with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (public.fn_user_role_in_org(organization_id) = 'provider' and owner_user_id = auth.uid())
        or public.fn_role_at_least(organization_id, 'agent')
      )
    )
  );

create policy calendar_appointments_delete on public.calendar_appointments
  for delete using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (public.fn_user_role_in_org(organization_id) = 'provider' and owner_user_id = auth.uid())
        or public.fn_role_at_least(organization_id, 'agent')
      )
    )
  );

alter table public.contacts enable row level security;
drop policy if exists tenant_isolation_contacts_all on public.contacts;
drop policy if exists contacts_select on public.contacts;
drop policy if exists contacts_insert on public.contacts;
drop policy if exists contacts_update on public.contacts;
drop policy if exists contacts_delete on public.contacts;

create policy contacts_select on public.contacts
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_user_role_in_org(organization_id) <> 'provider'
        or public.fn_provider_can_access_contact(organization_id, id)
      )
    )
  );

-- Um prestador nao cria um contato solto: o cadastro nasce pelo fluxo de
-- agendamento, que ja grava o vinculo. Os demais papeis mantem o comportamento.
create policy contacts_insert on public.contacts
  for insert with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_user_role_in_org(organization_id) <> 'provider'
    )
  );

create policy contacts_update on public.contacts
  for update using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_user_role_in_org(organization_id) <> 'provider'
        or public.fn_provider_can_access_contact(organization_id, id)
      )
    )
  ) with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_user_role_in_org(organization_id) <> 'provider'
        or public.fn_provider_can_access_contact(organization_id, id)
      )
    )
  );

create policy contacts_delete on public.contacts
  for delete using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_user_role_in_org(organization_id) <> 'provider'
        or public.fn_provider_can_access_contact(organization_id, id)
      )
    )
  );

notify pgrst, 'reload schema';
