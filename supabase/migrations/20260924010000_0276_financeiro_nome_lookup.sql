-- Roda a varredura dos contatos sem nome sem prender os lotes nos primeiros sem vínculo.
alter table public.contacts add column if not exists financeiro_name_lookup_at timestamptz;
create index if not exists contacts_financeiro_name_lookup_idx
  on public.contacts (organization_id, financeiro_name_lookup_at)
  where is_anonymized = false and (name is null or name = '');
