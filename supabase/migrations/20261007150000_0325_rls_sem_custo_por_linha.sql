-- 0325 — A regra de acesso deixa de refazer a checagem de suporte em cada linha.
--
-- Incidente de 07/10/2026: com o JWT de um usuário, `select count(*) from
-- conversations` (780 linhas) levava 10 s; `/conversations/counts` estourava o
-- statement timeout. A RLS chama `fn_user_role_in_org(organization_id)` POR
-- LINHA (via fn_can_view_conversation, fn_can_view_lead, fn_role_at_least,
-- contacts_select…), e desde a 0220 essa função chama `fn_support_context()` em
-- toda chamada — quatro joins, um exists em auth.mfa_factors e o parse do JWT.
--
-- Duas causas, dois consertos, NENHUMA mudança de quem vê ou faz o quê:
--
-- 1. Atalho barato. Sem sessão de suporte ABERTA do próprio auth.uid() (consulta
--    indexada pelo índice parcial abaixo), `fn_support_context()` devolve null
--    — o filtro dela exige a mesma linha (`actor_user_id = auth.uid() and
--    ended_at is null`) e mais. Então o atalho só pula o caminho que daria
--    null de qualquer jeito. Com sessão aberta, roda o caminho de antes, igual.
--
-- 2. Plano guardado. Função `language sql` que não é inlinada (toda SECURITY
--    DEFINER) é REPLANEJADA a cada chamada no Postgres ≤ 17; em PL/pgSQL o
--    plano fica guardado na sessão. As funções quentes da RLS passam a PL/pgSQL
--    com o MESMO corpo, devolvido por `return (...)` — mesma volatilidade
--    (stable), mesmo search_path, mesmos grants.
--
-- Medido no Postgres do test:db (pg15, 1000 conversas, membro `manager`):
-- antes 361 ms e 2010 chamadas de fn_support_context; depois 21 ms e nenhuma.
-- Ver tests/invariants/rls-sem-custo-por-linha.test.ts.

create index if not exists platform_support_sessions_open_by_actor
  on public.platform_support_sessions(actor_user_id) where ended_at is null;

create or replace function public.fn_support_context()
returns jsonb language plpgsql stable security definer set search_path = public as $f$
begin
 return (select jsonb_build_object('id', s.id, 'organization_id', s.organization_id,
 'actor_user_id', s.actor_user_id, 'auth_session_id', s.auth_session_id,
 'previous_organization_id', s.previous_organization_id, 'expires_at', s.expires_at,
 'name', o.display_name, 'locale', o.locale,
 'access_mode', case when s.access_mode = 'support_readonly' or p.scope <> 'full'
 then 'support_readonly' else 'full' end,
 'status', case when s.expires_at <= now() then 'expired'
 when p.user_id is null or a.id is null or (a.not_after is not null and a.not_after <= now())
 or o.status <> 'active' then 'revoked'
 when (p.mfa_required or exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified'))
 and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then 'revoked'
 else 'active' end)
 from public.platform_support_sessions s
 join public.organizations o on o.id=s.organization_id
 left join public.platform_admins p on p.user_id=s.actor_user_id and p.revoked_at is null
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 where s.actor_user_id=auth.uid()
 and s.auth_session_id=nullif(auth.jwt()->>'session_id','')::uuid and s.ended_at is null
 limit 1);
end $f$;
revoke all on function public.fn_support_context() from public, anon;
grant execute on function public.fn_support_context() to authenticated, service_role;

create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language plpgsql stable security definer set search_path = public as $f$
declare v_s jsonb;
begin
 if exists (select 1 from public.platform_support_sessions
             where actor_user_id = auth.uid() and ended_at is null) then
   v_s := public.fn_support_context();
   if v_s->>'status' = 'active' and (v_s->>'organization_id')::uuid = p_org then
     return case when v_s->>'access_mode' = 'full' then 'admin' else 'viewer' end;
   end if;
 end if;
 return (select role from public.user_organizations
          where user_id = auth.uid() and organization_id = p_org and revoked_at is null limit 1);
end $f$;
revoke all on function public.fn_user_role_in_org(uuid) from public, anon;
grant execute on function public.fn_user_role_in_org(uuid) to authenticated, service_role;

create or replace function public.fn_support_write_allowed(p_org uuid)
returns boolean language plpgsql stable security definer set search_path = public as $f$
begin
 if not exists (select 1 from public.platform_support_sessions
                 where actor_user_id = auth.uid() and ended_at is null) then
   return true;
 end if;
 return coalesce((select case when (s->>'organization_id')::uuid is distinct from p_org then true
 else s->>'status'='active' and s->>'access_mode'='full' end
 from (select public.fn_support_context() s) c where s is not null),true);
end $f$;
revoke all on function public.fn_support_write_allowed(uuid) from public, anon;
grant execute on function public.fn_support_write_allowed(uuid) to authenticated, service_role;

create or replace function public.fn_is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = public as $f$
begin
 return exists (select 1 from public.platform_admins
                 where user_id = auth.uid() and revoked_at is null);
end $f$;
revoke all on function public.fn_is_platform_admin() from public, anon;
grant execute on function public.fn_is_platform_admin() to authenticated, service_role;

create or replace function public.fn_role_at_least(p_org uuid, p_min text)
returns boolean language plpgsql stable security definer set search_path = public as $f$
begin
 return (with levels(role, lvl) as (
    values ('viewer',1),('provider',2),('agent',3),('manager',4),('admin',5)
  )
  select coalesce(
    (select user_lvl.lvl >= min_lvl.lvl
       from levels user_lvl
       join levels min_lvl on min_lvl.role = p_min
      where user_lvl.role = public.fn_user_role_in_org(p_org)),
    false
  ));
end $f$;
revoke all on function public.fn_role_at_least(uuid, text) from public, anon;
grant execute on function public.fn_role_at_least(uuid, text) to authenticated, service_role;

create or replace function public.fn_can_view_conversation(p_org uuid, p_assigned_to_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $f$
begin
 return (select case
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
  from (select public.fn_user_role_in_org(p_org) as papel offset 0) r);
end $f$;
revoke all on function public.fn_can_view_conversation(uuid, uuid) from public, anon;
grant execute on function public.fn_can_view_conversation(uuid, uuid) to authenticated, service_role;

create or replace function public.fn_can_view_lead(p_org uuid, p_owner_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $f$
begin
 return (select case
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
  from (select public.fn_user_role_in_org(p_org) as papel offset 0) r);
end $f$;
revoke all on function public.fn_can_view_lead(uuid, uuid) from public, anon;
grant execute on function public.fn_can_view_lead(uuid, uuid) to authenticated, service_role;
