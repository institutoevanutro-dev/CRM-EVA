import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "./gov-helpers";

/**
 * Migration 0325 — incidente de 07/10/2026: `count(*) from conversations` com o
 * JWT de um usuário levava 10 s porque a RLS chamava `fn_support_context()` uma
 * vez POR LINHA, mesmo sem sessão de suporte nenhuma.
 *
 * Duas perguntas, e as duas têm de ficar verdes:
 *  1. CUSTO — sem sessão de suporte, `fn_support_context` não roda nenhuma vez
 *     e a contagem de 1000 conversas é barata.
 *  2. NADA MUDOU — as funções novas devolvem, caso a caso, o mesmo que as
 *     definições de antes da 0325 (copiadas abaixo no schema `antiga`, corpo
 *     da 0220/0268/0035 como estava no baseline), para membro, atendente,
 *     membro revogado, outra organização, admin de plataforma, suporte
 *     `support_readonly` e `full`, sessão vencida, revogada, sem MFA provado e
 *     de outra sessão do mesmo ator. Se alguém mudar a REGRA de propósito, o
 *     oráculo muda junto — e o PR diz por quê.
 */
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 2 });

const A = "e3250000-0000-4000-8000-00000000000a";
const B = "e3250000-0000-4000-8000-00000000000b";
const CANAL_A = "e3250000-0000-4000-8000-0000000000ca";
const CANAL_B = "e3250000-0000-4000-8000-0000000000cb";
const GESTOR = "e3250000-1111-4000-8000-000000000001"; // manager de A
const ATENDENTE = "e3250000-1111-4000-8000-000000000002"; // agent de A
const REVOGADO = "e3250000-1111-4000-8000-000000000003"; // admin de A, revogado
const OUTRO = "e3250000-1111-4000-8000-000000000004"; // admin de B
const PLATAFORMA = "e3250000-1111-4000-8000-000000000005"; // admin de plataforma, sem vínculo
const SUPORTE = "e3250000-1111-4000-8000-000000000006"; // admin de plataforma (full) + admin de A
const SUPORTE_RO = "e3250000-1111-4000-8000-000000000007"; // admin de plataforma de escopo readonly
const PRESTADOR = "e3250000-1111-4000-8000-000000000008"; // provider de A
const SESSAO = "e3250000-2222-4000-8000-000000000001";
const OUTRA_SESSAO = "e3250000-2222-4000-8000-000000000002";
const SESSAO_RO = "e3250000-2222-4000-8000-000000000003";
const CONVERSAS_A = 1000;
const CONVERSAS_B = 5;

const ANTIGAS = `
create schema if not exists antiga;
create or replace function antiga.fn_support_context() returns jsonb language sql stable set search_path = public as $f$
 select jsonb_build_object('id', s.id, 'organization_id', s.organization_id,
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
 limit 1;
$f$;
create or replace function antiga.fn_support_write_allowed(p_org uuid) returns boolean language sql stable set search_path = public as $f$
 select coalesce((select case when (s->>'organization_id')::uuid is distinct from p_org then true
 else s->>'status'='active' and s->>'access_mode'='full' end
 from (select antiga.fn_support_context() s) c where s is not null),true);
$f$;
create or replace function antiga.fn_user_role_in_org(p_org uuid) returns text language sql stable set search_path = public as $f$
 select case when s->>'status'='active' and (s->>'organization_id')::uuid=p_org
 then case when s->>'access_mode'='full' then 'admin' else 'viewer' end
 else (select role from public.user_organizations where user_id=auth.uid() and organization_id=p_org and revoked_at is null limit 1) end
 from (select antiga.fn_support_context() s) c;
$f$;
create or replace function antiga.fn_is_platform_admin() returns boolean language sql stable set search_path = public as $f$
  select exists (select 1 from public.platform_admins where user_id = auth.uid() and revoked_at is null);
$f$;
create or replace function antiga.fn_role_at_least(p_org uuid, p_min text) returns boolean language sql stable set search_path = public as $f$
  with levels(role, lvl) as (values ('viewer',1),('provider',2),('agent',3),('manager',4),('admin',5))
  select coalesce((select user_lvl.lvl >= min_lvl.lvl from levels user_lvl join levels min_lvl on min_lvl.role = p_min
      where user_lvl.role = antiga.fn_user_role_in_org(p_org)), false);
$f$;
create or replace function antiga.fn_can_view(p_org uuid, p_dono uuid) returns boolean language sql stable set search_path = public as $f$
  select case
    when antiga.fn_is_platform_admin() then true
    when r.papel is null then false
    when r.papel = 'provider' then p_dono = auth.uid()
    when r.papel in ('viewer','manager','admin') then true
    when p_dono = auth.uid() then true
    else case coalesce((select settings->>'visibility_mode' from public.organizations where id = p_org), 'own_and_unassigned')
         when 'all' then true when 'own_and_unassigned' then p_dono is null else false end
  end
  from (select antiga.fn_user_role_in_org(p_org) as papel offset 0) r;
$f$;`;

/** Compara antiga x nova em toda combinação de organização, dono e papel mínimo; devolve quantas comparou. */
const COMPARA = `
do $c$
declare o uuid; d uuid; m text; n int := 0;
begin
  foreach o in array array['${A}','${B}',null,gen_random_uuid()]::uuid[] loop
    if public.fn_user_role_in_org(o) is distinct from antiga.fn_user_role_in_org(o) then raise exception 'papel divergiu em %', o; end if;
    if public.fn_support_write_allowed(o) is distinct from antiga.fn_support_write_allowed(o) then raise exception 'escrita de suporte divergiu em %', o; end if;
    foreach m in array array['viewer','provider','agent','manager','admin','inexistente'] loop
      if public.fn_role_at_least(o, m) is distinct from antiga.fn_role_at_least(o, m) then raise exception 'role_at_least divergiu em % %', o, m; end if;
      n := n + 1;
    end loop;
    foreach d in array array[null,'${GESTOR}','${ATENDENTE}','${PRESTADOR}','${SUPORTE}',gen_random_uuid()]::uuid[] loop
      if public.fn_can_view_conversation(o, d) is distinct from antiga.fn_can_view(o, d) then raise exception 'conversa divergiu em % %', o, d; end if;
      if public.fn_can_view_lead(o, d) is distinct from antiga.fn_can_view(o, d) then raise exception 'lead divergiu em % %', o, d; end if;
      n := n + 2;
    end loop;
  end loop;
  if public.fn_is_platform_admin() is distinct from antiga.fn_is_platform_admin() then raise exception 'admin de plataforma divergiu'; end if;
  if public.fn_support_context() is distinct from antiga.fn_support_context() then raise exception 'contexto de suporte divergiu'; end if;
  raise notice 'comparou %', n;
end $c$;`;

const claims = (sub: string | null, session = SESSAO, aal = "aal1") =>
  sub === null
    ? `select set_config('request.jwt.claims','',true);`
    : `select set_config('request.jwt.claims','{"sub":"${sub}","session_id":"${session}","aal":"${aal}","role":"authenticated"}',true);`;

/** Roda `preparo` (como postgres) e depois, com as claims, compara e conta pela RLS real. */
function cenario(preparo: string, claimsSql: string): { conversas: number; contatos: number; leads: number } {
  const out = sql(`begin;
${preparo}
${claimsSql}
${COMPARA}
set local role authenticated;
select (select count(*) from public.conversations)||','||(select count(*) from public.contacts)||','||(select count(*) from public.crm_leads);
rollback;`);
  const [conversas, contatos, leads] = ultima(out).split(",").map(Number);
  return { conversas: conversas!, contatos: contatos!, leads: leads! };
}

/** Última linha de resultado, ignorando as etiquetas de comando do psql (BEGIN, SET, ROLLBACK…). */
const ultima = (out: string) => out.split("\n").filter((l) => !/^[A-Z]+( \d+)*$/.test(l)).pop() ?? "";

const iniciar = (modo: string, ator = SUPORTE, sessao = SESSAO) =>
  `select public.fn_start_support('${ator}','${sessao}','${B}',null,'${modo}',3600);`;

beforeAll(() => {
  const usuarios = [GESTOR, ATENDENTE, REVOGADO, OUTRO, PLATAFORMA, SUPORTE, SUPORTE_RO, PRESTADOR]
    .map((id, i) => `('${id}','rls-0325-${i}@invariant.test')`).join(",");
  sql(`
    insert into auth.users(id,email) values ${usuarios};
    insert into auth.sessions(id,user_id,aal) values ('${SESSAO}','${SUPORTE}','aal1'),('${OUTRA_SESSAO}','${SUPORTE}','aal1'),('${SESSAO_RO}','${SUPORTE_RO}','aal1');
    insert into public.organizations(id,slug,display_name,legal_name) values ('${A}','rls-0325-a','A','A'),('${B}','rls-0325-b','B','B');
    insert into public.user_organizations(organization_id,user_id,role,accepted_at,revoked_at) values
      ('${A}','${GESTOR}','manager',now(),null), ('${A}','${ATENDENTE}','agent',now(),null),
      ('${A}','${REVOGADO}','admin',now(),now()), ('${B}','${OUTRO}','admin',now(),null),
      ('${A}','${SUPORTE}','admin',now(),null), ('${A}','${PRESTADOR}','provider',now(),null);
    insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values
      ('${PLATAFORMA}','${PLATAFORMA}','full',false,'teste 0325'),
      ('${SUPORTE}','${SUPORTE}','full',false,'teste 0325'),
      ('${SUPORTE_RO}','${SUPORTE_RO}','support_readonly',false,'teste 0325');
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values
      ('${CANAL_A}','${A}','rls-0325-a','\\x00'::bytea), ('${CANAL_B}','${B}','rls-0325-b','\\x00'::bytea);
    insert into public.contacts(id,organization_id,display_name)
      select ('e3250000-3333-4000-8000-'||lpad(i::text,12,'0'))::uuid, case when i <= ${CONVERSAS_A} then '${A}'::uuid else '${B}'::uuid end, 'c'||i
        from generate_series(1, ${CONVERSAS_A + CONVERSAS_B}) i;
    -- Em A: 10 do atendente, 10 do gestor, o resto sem dono.
    insert into public.conversations(organization_id,contact_id,channel_session_id,status,assigned_to_user_id)
      select case when i <= ${CONVERSAS_A} then '${A}'::uuid else '${B}'::uuid end,
             ('e3250000-3333-4000-8000-'||lpad(i::text,12,'0'))::uuid,
             case when i <= ${CONVERSAS_A} then '${CANAL_A}'::uuid else '${CANAL_B}'::uuid end, 'open',
             case when i <= 10 then '${ATENDENTE}'::uuid when i <= 20 then '${GESTOR}'::uuid end
        from generate_series(1, ${CONVERSAS_A + CONVERSAS_B}) i;
    analyze public.conversations;
    ${ANTIGAS}
  `);
});
afterAll(() => pool.end());

describe("0325: sem sessão de suporte, a RLS não refaz a checagem de suporte por linha", () => {
  it("índice parcial das sessões abertas por ator existe", () => {
    expect(sql(`select indexdef from pg_indexes where indexname='platform_support_sessions_open_by_actor';`))
      .toMatch(/\(actor_user_id\) WHERE \(ended_at IS NULL\)/);
  });

  it(`count(*) de ${CONVERSAS_A} conversas sob JWT de membro: fn_support_context roda 0 vezes e custa pouco`, async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local track_functions = 'all'");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: GESTOR, session_id: SESSAO, aal: "aal1" })]);
      const t0 = performance.now();
      const r = await c.query("select count(*)::int n from public.conversations");
      const ms = performance.now() - t0;
      await c.query("reset role");
      const chamadas = await c.query(`select coalesce(pg_stat_get_xact_function_calls('public.fn_support_context()'::regprocedure),0)::int ctx,
                                             coalesce(pg_stat_get_xact_function_calls('public.fn_user_role_in_org(uuid)'::regprocedure),0)::int papel`);
      process.stdout.write(`[0325] count(*)=${r.rows[0].n} em ${ms.toFixed(1)} ms; fn_support_context=${chamadas.rows[0].ctx}x, fn_user_role_in_org=${chamadas.rows[0].papel}x\n`);
      expect(r.rows[0].n).toBe(CONVERSAS_A);
      expect(chamadas.rows[0].ctx).toBe(0);
      expect(ms).toBeLessThan(1500);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("0325: quem vê e quem escreve não mudou (oráculo = definições de antes)", () => {
  it("membro gestor vê A inteira; atendente vê as suas e as sem dono; prestador só as suas", () => {
    expect(cenario("", claims(GESTOR)).conversas).toBe(CONVERSAS_A);
    expect(cenario("", claims(ATENDENTE)).conversas).toBe(CONVERSAS_A - 10);
    expect(cenario("", claims(PRESTADOR)).conversas).toBe(0);
  });

  it("membro revogado não vê nada; outra organização vê só a sua", () => {
    expect(cenario("", claims(REVOGADO))).toEqual({ conversas: 0, contatos: 0, leads: 0 });
    const outro = cenario("", claims(OUTRO));
    expect(outro.conversas).toBe(CONVERSAS_B);
    expect(outro.contatos).toBe(CONVERSAS_B);
  });

  it("admin de plataforma vê tudo; sem claims não vê nada", () => {
    expect(cenario("", claims(PLATAFORMA)).conversas).toBe(CONVERSAS_A + CONVERSAS_B);
    expect(cenario("", claims(null)).conversas).toBe(0);
  });

  it("suporte full e support_readonly em B: papel admin/viewer só na sessão certa", () => {
    // Sem sessão aberta, o ator de suporte é só o admin de A que já era.
    expect(cenario("", claims(SUPORTE)).conversas).toBe(CONVERSAS_A + CONVERSAS_B); // também é admin de plataforma
    expect(ultima(sql(`begin; ${iniciar("full")} ${claims(SUPORTE)} select public.fn_user_role_in_org('${B}')||','||public.fn_support_write_allowed('${B}'); rollback;`))).toBe("admin,true");
    expect(ultima(sql(`begin; ${iniciar("support_readonly")} ${claims(SUPORTE)} select public.fn_user_role_in_org('${B}')||','||public.fn_support_write_allowed('${B}')||','||public.fn_support_write_allowed('${A}'); rollback;`))).toBe("viewer,false,true");
    // Escopo de plataforma readonly rebaixa o pedido de full.
    expect(ultima(sql(`begin; ${iniciar("full", SUPORTE_RO, SESSAO_RO)} ${claims(SUPORTE_RO, SESSAO_RO)} select public.fn_user_role_in_org('${B}'); rollback;`))).toBe("viewer");
    for (const preparo of [iniciar("full"), iniciar("support_readonly"), iniciar("full", SUPORTE_RO, SESSAO_RO)]) {
      cenario(preparo, claims(SUPORTE));
      cenario(preparo, claims(SUPORTE_RO, SESSAO_RO));
      cenario(preparo, claims(SUPORTE, OUTRA_SESSAO));
      cenario(preparo, claims(GESTOR));
    }
  });

  it("support_readonly não escreve em B pela RLS", () => {
    const out = sql(`begin; ${iniciar("support_readonly")} ${claims(SUPORTE)} set local role authenticated;
      with w as (update public.conversations set status = status where organization_id='${B}' returning 1) select count(*) from w; rollback;`);
    expect(ultima(out)).toBe("0");
    const full = sql(`begin; ${iniciar("full")} ${claims(SUPORTE)} set local role authenticated;
      with w as (update public.conversations set status = status where organization_id='${B}' returning 1) select count(*) from w; rollback;`);
    expect(ultima(full)).toBe(String(CONVERSAS_B));
  });

  it("sessão vencida, admin revogado, sessão do Auth apagada e MFA não provado: mesmo veredito de antes", () => {
    const invalidacoes = [
      "update public.platform_support_sessions set expires_at = now() - interval '1 second';",
      `update public.platform_admins set revoked_at = now() where user_id = '${SUPORTE}';`,
      `delete from auth.sessions where id = '${SESSAO}';`,
      `update public.platform_admins set mfa_required = true where user_id = '${SUPORTE}';`,
      `insert into auth.mfa_factors(id,user_id,status) values (gen_random_uuid(),'${SUPORTE}','verified');`,
      "update public.platform_support_sessions set ended_at = now();",
    ];
    for (const inv of invalidacoes) {
      cenario(`${iniciar("full")} ${inv}`, claims(SUPORTE));
      cenario(`${iniciar("full")} ${inv}`, claims(SUPORTE, SESSAO, "aal2"));
      cenario(`${iniciar("support_readonly")} ${inv}`, claims(SUPORTE));
    }
    // MFA exigido e provado (aal2) mantém o suporte ativo; aal1 o derruba.
    const mfa = `${iniciar("full")} update public.platform_admins set mfa_required = true where user_id = '${SUPORTE}';`;
    expect(ultima(sql(`begin; ${mfa} ${claims(SUPORTE, SESSAO, "aal2")} select public.fn_support_context()->>'status'; rollback;`))).toBe("active");
    expect(ultima(sql(`begin; ${mfa} ${claims(SUPORTE, SESSAO, "aal1")} select public.fn_support_context()->>'status'; rollback;`))).toBe("revoked");
  });

  it("todo cenário simples também bate com o oráculo (membro, atendente, revogado, outra org, plataforma, anônimo)", () => {
    for (const quem of [GESTOR, ATENDENTE, REVOGADO, OUTRO, PLATAFORMA, PRESTADOR, SUPORTE_RO]) cenario("", claims(quem));
  });
});

describe("0325: as funções redefinidas seguem fechadas para anon", () => {
  it("nenhuma executável por anon ou PUBLIC; todas por authenticated", () => {
    const out = sql(`select string_agg(p.proname||':'||has_function_privilege('anon',p.oid,'execute')::text||':'||has_function_privilege('authenticated',p.oid,'execute')::text||':'||l.lanname, ',' order by p.proname)
      from pg_proc p join pg_language l on l.oid=p.prolang where p.pronamespace='public'::regnamespace and p.proname in
      ('fn_support_context','fn_user_role_in_org','fn_support_write_allowed','fn_is_platform_admin','fn_role_at_least','fn_can_view_conversation','fn_can_view_lead');`);
    for (const linha of out.split(",")) expect(linha).toMatch(/^[a-z_]+:false:true:plpgsql$/);
    expect(out.split(",")).toHaveLength(7);
  });
});
