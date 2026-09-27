-- Identidade opaca do paciente do prontuário EVA. Não contém dados clínicos.
-- A escrita é exclusiva do service_role após validação do Bearer na API.
create unique index if not exists contacts_org_id_for_prontuario_fk
  on public.contacts (organization_id, id);

create table if not exists public.prontuario_contact_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_patient_id uuid not null,
  contact_id uuid not null,
  create_request_key uuid,
  linked_at timestamptz not null default now(),
  linked_by_api_token_id uuid references public.api_tokens(id) on delete set null,
  unique (organization_id, source_patient_id),
  unique (organization_id, contact_id),
  unique (organization_id, create_request_key),
  foreign key (organization_id, contact_id) references public.contacts(organization_id, id) on delete cascade
);

alter table public.prontuario_contact_links enable row level security;
drop policy if exists tenant_isolation_prontuario_contact_links_select on public.prontuario_contact_links;
create policy tenant_isolation_prontuario_contact_links_select on public.prontuario_contact_links
  for select using (organization_id in (select public.fn_user_org_ids()));

revoke all on public.prontuario_contact_links from public, anon, authenticated;
grant select on public.prontuario_contact_links to authenticated;
grant all on public.prontuario_contact_links to service_role;

-- Depois de anonimizar ou fundir o contato, o ID do paciente externo não pode
-- continuar reidentificando o registro no CRM.
create or replace function public.fn_prontuario_desvincular_contato_indisponivel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.is_anonymized or new.is_merged_into is not null)
     and (not old.is_anonymized and old.is_merged_into is null) then
    delete from public.prontuario_contact_links
     where organization_id = new.organization_id and contact_id = new.id;
  end if;
  return new;
end; $$;
revoke execute on function public.fn_prontuario_desvincular_contato_indisponivel() from public, anon, authenticated;
grant execute on function public.fn_prontuario_desvincular_contato_indisponivel() to service_role;
drop trigger if exists trg_prontuario_desvincular_contato_indisponivel on public.contacts;
create trigger trg_prontuario_desvincular_contato_indisponivel
  after update of is_anonymized, is_merged_into on public.contacts
  for each row execute function public.fn_prontuario_desvincular_contato_indisponivel();
