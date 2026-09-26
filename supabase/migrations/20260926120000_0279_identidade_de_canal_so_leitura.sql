-- Identidade de canal é LIDA pela equipe, nunca escrita por ela. A policy
-- `for all` da 0277 deixava qualquer `agent` logado gravar/trocar o `handle`
-- de uma identidade pela REST, e a junção automática por @ (service role)
-- funde contatos de mesmo handle: um agent disparava um merge irreversível
-- que só `manager` pode fazer. Quem escreve é só o service role (webhook,
-- preenchimento de perfil, junção), que ignora RLS. Fica só o SELECT.
drop policy if exists tenant_isolation_contact_channel_identities_all on public.contact_channel_identities;
drop policy if exists tenant_isolation_contact_channel_identities_select on public.contact_channel_identities;
create policy tenant_isolation_contact_channel_identities_select on public.contact_channel_identities
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );
