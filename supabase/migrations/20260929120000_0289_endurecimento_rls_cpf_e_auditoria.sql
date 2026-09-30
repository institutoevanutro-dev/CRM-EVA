-- ── Endurecimento de RLS, índice de CPF e trilha de auditoria ───────────────
--
-- Auditoria de segurança de 2026-09-29 (achados A1, A2, A3, A4, A7, M1, M4,
-- B2 e dois complementos: lead_state e a exclusão de contato). Todos os
-- achados têm a mesma forma: a ROTA cobra um papel, e o BANCO não repete a
-- regra — e a anon key + o JWT de qualquer membro chegam ao PostgREST sem
-- passar pela rota. Cada bloco abaixo põe no schema o que só a prosa dizia.
--
-- Idempotente e auto-curativo: `drop policy if exists` + `create policy`,
-- `create or replace function`, grants enumerados. O apêndice do baseline
-- repete este arquivo.
--
-- ── A1 — contacts: viewer não escreve, provider só o que é dele, delete é de manager
-- As policies exigiam só `role <> 'provider'`, e a tabela tem GRANT ALL a
-- `authenticated`: um viewer apagava a ficha pela REST, em cascata por 14
-- tabelas, sem uma linha de auditoria. Agora: insert/update pedem `agent`
-- (provider mantém o caminho de `fn_provider_can_access_contact` no update),
-- delete pede `manager`. E `is_anonymized` só anda para true: a doutrina
-- LGPD diz "anonimização irreversível" e nenhum trigger a fazia valer.
--
-- ── A2 — cpf_hash deixa de ser sha256 sem chave
-- O CPF tem 10^9 valores: um sha256 puro se reverte inteiro numa GPU em
-- segundos, e a coluna ia para a tela em toda resposta da API. `cpf_indice`
-- é HMAC-SHA256 com a MESMA chave da instalação que já cifra o CPF
-- (`private.fn_oauth_key`, migration 0041/0274), com separação de domínio
-- ('cpf-idx:'). Só a service role executa. O backfill troca o hash das
-- linhas que ainda são sha256 do CPF decifrado — em bloco com `exception`,
-- porque um banco sem chave (instalação que nunca gravou CPF) não pode
-- derrubar o `update.sh`. E `authenticated` perde o SELECT da coluna: o
-- grant passa a ser por coluna, enumerado. ⚠️ Coluna nova em `contacts`
-- precisa de `grant select (coluna) ... to authenticated` — o invariante
-- `tests/invariants/endurecimento-0289.test.ts` reprova quem esquecer.
--
-- ── A3 — provider vê só a conversa e o lead que são dele
-- `fn_can_view_conversation`/`fn_can_view_lead` caíam no ramo do agent para
-- o provider, e o agent vê o que está sem responsável. Um profissional
-- parceiro lia o WhatsApp de pacientes que não atende.
-- O papel é lido UMA vez por linha (`offset 0`): o ramo novo somava uma terceira
-- chamada de fn_user_role_in_org, e o Radar do agent (500+ leads) passou do
-- timeout da tela no e2e. Vigiado em tests/invariants/endurecimento-0289.test.ts.
--
-- ── A4 — ninguém com sessão grava auditoria
-- `audit_log_insert_tenant_member` deixava qualquer membro inserir linha com
-- ator, ação e data livres. O app grava pela service role (lib/audit).
--
-- ── A7 — webhook_events_log fecha para a REST e guarda só o hash do token
-- Guardava o WhatsApp cru dos últimos 7 dias e o token da rota, legível por
-- qualquer membro. Sem SELECT para anon/authenticated; a coluna
-- `webhook_path_token` passa a guardar sha256 hex (o app grava e consulta
-- pelo hash — `lib/channels/arquivo-de-webhook.ts`).
--
-- ── M1/B2 — storage: lgpd-exports só para admin; ai-policy escreve manager
-- ── M4 — api_audit_log.actor_user_id perde a FK: apagar o usuário apagava o
--   "quem" da trilha (on delete set null). O uuid fica; o app grava snapshot.
-- ── lead_state — viewer escrevia direto pela REST (policy for all, só membro).
--   Leitura segue para membro; escrita pede `agent`.

-- ---- A1: contacts ----
drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
    )
  );

drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_role_at_least(organization_id, 'agent')
        or (
          public.fn_user_role_in_org(organization_id) = 'provider'
          and public.fn_provider_can_access_contact(organization_id, id)
        )
      )
    )
  ) with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_role_at_least(organization_id, 'agent')
        or (
          public.fn_user_role_in_org(organization_id) = 'provider'
          and public.fn_provider_can_access_contact(organization_id, id)
        )
      )
    )
  );

drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

create or replace function public.fn_contacts_anonimizacao_irreversivel() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.is_anonymized and not new.is_anonymized then
    raise exception 'lgpd_anonymization_irreversible' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.fn_contacts_anonimizacao_irreversivel() from public, anon, authenticated;
drop trigger if exists trg_contacts_anonimizacao_irreversivel on public.contacts;
create trigger trg_contacts_anonimizacao_irreversivel
  before update of is_anonymized on public.contacts
  for each row execute function public.fn_contacts_anonimizacao_irreversivel();

-- ---- lead_state: leitura de membro, escrita de agent+ ----
drop policy if exists tenant_isolation_lead_state_all on public.lead_state;
drop policy if exists lead_state_select on public.lead_state;
drop policy if exists lead_state_write on public.lead_state;
create policy lead_state_select on public.lead_state
  for select using (organization_id in (select public.fn_user_org_ids()));
create policy lead_state_write on public.lead_state
  for all using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

-- ---- A2: cpf_indice (HMAC com a chave da instalação) ----
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.cpf_indice(p_plaintext text) returns text
    language plpgsql stable security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
  v_digitos text := regexp_replace(coalesce(p_plaintext, ''), '\D', '', 'g');
begin
  if k is null or length(k) < 32 then
    raise exception 'chave de cifra da instalação ausente — rode o update.sh'
      using errcode = '55000';
  end if;
  if length(v_digitos) <> 11 then
    raise exception 'CPF deve ter 11 dígitos' using errcode = '22023';
  end if;
  return encode(extensions.hmac(v_digitos, 'cpf-idx:' || k, 'sha256'), 'hex');
end$$;

revoke execute on function public.cpf_indice(text) from public, anon, authenticated;
grant  execute on function public.cpf_indice(text) to service_role;

-- Backfill: só as linhas cujo hash ainda é o sha256 puro do CPF decifrado.
-- Em bloco com exception: banco sem chave (nunca gravou CPF) ou linha que não
-- decifra não pode derrubar a atualização — fica o aviso e o hash antigo.
do $$
declare v_n int;
begin
  update public.contacts
     set cpf_hash = public.cpf_indice(public.decrypt_cpf(id))
   where cpf_encrypted is not null
     and cpf_hash = encode(extensions.digest(public.decrypt_cpf(id), 'sha256'), 'hex');
  get diagnostics v_n = row_count;
  if v_n > 0 then raise notice 'cpf_hash: % linha(s) migradas para HMAC', v_n; end if;
exception when others then
  raise warning 'cpf_hash: backfill para HMAC não rodou (%): rode o update.sh de novo com a chave presente', sqlerrm;
end $$;

-- `authenticated` lê toda coluna de contacts MENOS cpf_hash (grant por coluna).
-- Um privilégio de coluna não se subtrai de um GRANT de tabela: é preciso
-- revogar o SELECT da tabela e conceder as colunas uma a uma.
revoke select on public.contacts from anon, authenticated;
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
    from pg_attribute
   where attrelid = 'public.contacts'::regclass
     and attnum > 0 and not attisdropped and attname <> 'cpf_hash';
  execute format('grant select (%s) on public.contacts to authenticated', v_cols);
end $$;

-- ---- A3: provider só vê o que é dele ----
create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when r.papel is null then false
    when r.papel = 'provider' then p_assigned_to_user_id = auth.uid()
    when r.papel in ('viewer','manager','admin') then true
    when p_assigned_to_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_assigned_to_user_id is null
         else false
       end
  end
  -- `offset 0` impede o planner de achatar a subquery e reavaliar o papel a
  -- cada WHEN: fn_user_role_in_org custa ~0,3 ms e esta função roda POR LINHA
  -- na RLS de crm_leads/conversations — 500 leads no Radar eram 1.500 chamadas.
  from (select public.fn_user_role_in_org(p_org) as papel offset 0) r;
$$;
revoke all on function public.fn_can_view_conversation(uuid, uuid) from public;
revoke execute on function public.fn_can_view_conversation(uuid, uuid) from anon;
grant execute on function public.fn_can_view_conversation(uuid, uuid) to authenticated, service_role;

create or replace function public.fn_can_view_lead(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when r.papel is null then false
    when r.papel = 'provider' then p_owner_user_id = auth.uid()
    when r.papel in ('viewer','manager','admin') then true
    when p_owner_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_owner_user_id is null
         else false
       end
  end
  -- `offset 0` impede o planner de achatar a subquery e reavaliar o papel a
  -- cada WHEN: fn_user_role_in_org custa ~0,3 ms e esta função roda POR LINHA
  -- na RLS de crm_leads/conversations — 500 leads no Radar eram 1.500 chamadas.
  from (select public.fn_user_role_in_org(p_org) as papel offset 0) r;
$$;
revoke all on function public.fn_can_view_lead(uuid, uuid) from public;
revoke execute on function public.fn_can_view_lead(uuid, uuid) from anon;
grant execute on function public.fn_can_view_lead(uuid, uuid) to authenticated, service_role;

-- ---- A4 + M4: api_audit_log ----
drop policy if exists audit_log_insert_tenant_member on public.api_audit_log;
revoke insert on public.api_audit_log from anon, authenticated;
alter table public.api_audit_log drop constraint if exists api_audit_log_actor_user_id_fkey;

-- ---- A7: webhook_events_log ----
revoke select on public.webhook_events_log from anon, authenticated;
drop policy if exists webhook_events_log_tenant_read on public.webhook_events_log;
-- Token em claro vira sha256 hex. Um valor que já tem 64 hex é hash e fica.
update public.webhook_events_log
   set webhook_path_token = encode(extensions.digest(webhook_path_token, 'sha256'), 'hex')
 where webhook_path_token is not null
   and webhook_path_token !~ '^[0-9a-f]{64}$';

-- ---- M1: lgpd-exports só para admin ----
drop policy if exists "tenant_read_lgpd_exports" on storage.objects;
create policy "tenant_read_lgpd_exports" on storage.objects for select
  to authenticated using (
    bucket_id = 'lgpd-exports'
    and public.fn_role_at_least((split_part(name, '/', 1))::uuid, 'admin')
  );

-- ---- B2: ai-policy escreve e apaga manager+ ----
drop policy if exists "tenant_write_ai_policy" on storage.objects;
create policy "tenant_write_ai_policy" on storage.objects for insert
  to authenticated with check (
    bucket_id = 'ai-policy'
    and public.fn_role_at_least((split_part(name, '/', 1))::uuid, 'manager')
  );
drop policy if exists "tenant_delete_ai_policy" on storage.objects;
create policy "tenant_delete_ai_policy" on storage.objects for delete
  to authenticated using (
    bucket_id = 'ai-policy'
    and public.fn_role_at_least((split_part(name, '/', 1))::uuid, 'manager')
  );

notify pgrst, 'reload schema';
