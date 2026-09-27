-- 0287: entrada pela Conta EvaLink (opcional; sem as variáveis EVALINK_* nada disso é usado).
-- Ligação pessoa da Conta (sub) com usuário do CRM é por sub, NUNCA por e-mail.
-- Tabelas por pessoa (como platform_admins), sem organization_id: não são dados de tenant.
-- Só a service role alcança: tabelas sem grant para anon/authenticated, funções revogadas.

create table if not exists public.evalink_vinculos (
  user_id uuid primary key references auth.users(id) on delete cascade,
  evalink_sub uuid not null unique,
  created_at timestamptz not null default now()
);
alter table public.evalink_vinculos enable row level security;
revoke all on public.evalink_vinculos from anon, authenticated;

create table if not exists public.evalink_avisos_vistos (
  id uuid primary key,
  at timestamptz not null default now()
);
alter table public.evalink_avisos_vistos enable row level security;
revoke all on public.evalink_avisos_vistos from anon, authenticated;

-- Toda referência a user_id dentro destas funções leva alias: o parâmetro de saída
-- `user_id` do `returns table` tornaria a coluna ambígua.
create or replace function public.fn_evalink_entrada(p_sub uuid, p_email text, p_papel text, p_org_padrao uuid)
returns table (user_id uuid, motivo text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  if p_papel is null or p_papel not in ('viewer','agent','manager','admin') then
    raise exception 'evalink_papel_invalido';
  end if;
  if p_email is null or btrim(p_email) = '' then raise exception 'evalink_email_invalido'; end if;
  select v.user_id into v_user from evalink_vinculos v where v.evalink_sub = p_sub;
  if v_user is null then
    if exists (select 1 from auth.users u where lower(u.email) = lower(p_email)) then
      return query select null::uuid, 'conflito'::text; return;
    end if;
    -- organização arquivada, suspensa ou anonimizada conta como apagada
    if not exists (select 1 from organizations o where o.id = p_org_padrao and o.status = 'active') then
      return query select null::uuid, 'sem_org_padrao'::text; return;
    end if;
    return query select null::uuid, 'novo'::text; return;
  end if;
  if not exists (select 1 from user_organizations uo where uo.user_id = v_user and uo.revoked_at is null) then
    return query select v_user, 'sem_organizacao'::text; return;
  end if;
  -- trava os admins ativos de toda organização da pessoa: sem isso duas entradas
  -- simultâneas (dois admins rebaixados ao mesmo tempo) passariam juntas pela checagem
  perform 1 from user_organizations uo
    where uo.organization_id in (select m.organization_id from user_organizations m
                                 where m.user_id = v_user and m.revoked_at is null)
      and uo.role = 'admin' and uo.revoked_at is null
    for update of uo;
  -- tudo ou nada: se tirar o admin deixaria QUALQUER organização sem admin ativo, não muda nenhuma
  if p_papel <> 'admin' and exists (
    select 1 from user_organizations uo
    where uo.user_id = v_user and uo.revoked_at is null and uo.role = 'admin'
      and not exists (select 1 from user_organizations o2
                      where o2.organization_id = uo.organization_id and o2.role = 'admin'
                        and o2.revoked_at is null and o2.user_id <> v_user)) then
    return query select v_user, 'ultimo_admin'::text; return;
  end if;
  update user_organizations uo set role = p_papel
    where uo.user_id = v_user and uo.revoked_at is null and uo.role is distinct from p_papel;
  return query select v_user, null::text;
end $$;

-- user_organizations: obrigatórias só user_id, organization_id e role (o resto tem default
-- ou é nulável); o trigger after insert (adoção de tipos de agendamento) não pede nada.
create or replace function public.fn_evalink_ligar_novo(p_user uuid, p_sub uuid, p_org uuid, p_papel text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_papel is null or p_papel not in ('viewer','agent','manager','admin') then
    raise exception 'evalink_papel_invalido';
  end if;
  insert into evalink_vinculos (user_id, evalink_sub) values (p_user, p_sub);
  insert into user_organizations (user_id, organization_id, role, accepted_at)
    values (p_user, p_org, p_papel, now());
end $$;

create or replace function public.fn_evalink_aviso(p_sub uuid, p_aviso uuid)
returns table (user_id uuid, novo boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid; v_novo boolean;
begin
  delete from evalink_avisos_vistos a where a.at < now() - interval '1 day';
  insert into evalink_avisos_vistos (id) values (p_aviso) on conflict do nothing;
  v_novo := found;  -- found do INSERT: false quando o id já tinha sido visto
  if not v_novo then return query select null::uuid, false; return; end if;
  select v.user_id into v_user from evalink_vinculos v where v.evalink_sub = p_sub;
  if v_user is not null then delete from auth.sessions s where s.user_id = v_user; end if;
  return query select v_user, true;
end $$;

revoke execute on function public.fn_evalink_entrada(uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.fn_evalink_ligar_novo(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fn_evalink_aviso(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_evalink_entrada(uuid, text, text, uuid) to service_role;
grant execute on function public.fn_evalink_ligar_novo(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fn_evalink_aviso(uuid, uuid) to service_role;
