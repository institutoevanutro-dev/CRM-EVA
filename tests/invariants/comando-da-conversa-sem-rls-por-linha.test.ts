import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "./gov-helpers";

/**
 * Migration 0331 — `comando_da_conversa(c)` lê o contato UMA vez, por uma
 * `security definer` com guarda de organização, em vez de duas subconsultas sob a
 * RLS de `contacts` (1,25 s → 0,51 s por contagem em produção, 07/10/2026).
 *
 *  1. NADA MUDOU — para quem vê as conversas, o campo calculado devolve, conversa a
 *     conversa, o mesmo que a definição anterior (copiada em `antiga`).
 *  2. A GUARDA — o booleano de um contato de outra organização sai `false`, e a
 *     função não é executável por `anon`.
 */
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 2 });

const A = "e3310000-0000-4000-8000-00000000000a";
const B = "e3310000-0000-4000-8000-00000000000b";
const CANAL = "e3310000-0000-4000-8000-0000000000ca";
const GESTOR = "e3310000-1111-4000-8000-000000000001"; // manager de A
const OUTRO = "e3310000-1111-4000-8000-000000000002"; // admin de B
const BLOQUEADO = "e3310000-3333-4000-8000-000000000001"; // contato de A, is_blocked

const ANTIGA = `
create schema if not exists antiga;
create or replace function antiga.comando_da_conversa(c public.conversations) returns text language sql stable set search_path = public as $f$
  select public.fn_comando_da_conversa(c.status, c.assigned_to_user_id, c.bot_silenced_until,
    coalesce((select ct.force_human from public.contacts ct where ct.id = c.contact_id), false),
    coalesce((select ct.is_blocked  from public.contacts ct where ct.id = c.contact_id), false),
    now());
$f$;
grant usage on schema antiga to authenticated;
grant execute on function antiga.comando_da_conversa(public.conversations) to authenticated;
`;

async function como<T>(sub: string, fn: (q: (t: string, v?: unknown[]) => Promise<{ rows: T[] }>) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub, aal: "aal1", role: "authenticated" })]);
    await fn(async (t, v) => (await c.query(t, v as unknown[])) as unknown as { rows: T[] });
  } finally {
    await c.query("rollback");
    c.release();
  }
}

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values ('${GESTOR}','c0331-1@invariant.test'),('${OUTRO}','c0331-2@invariant.test');
    insert into public.organizations(id,slug,display_name,legal_name) values ('${A}','c0331-a','A','A'),('${B}','c0331-b','B','B');
    insert into public.user_organizations(organization_id,user_id,role,accepted_at) values ('${A}','${GESTOR}','manager',now()),('${B}','${OUTRO}','admin',now());
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values ('${CANAL}','${A}','c0331-a','\\x00'::bytea);
    -- 40 contatos em A: 1 bloqueado (o BLOQUEADO), a cada 5 force_human, a cada 7 bloqueado.
    insert into public.contacts(id,organization_id,display_name,force_human,is_blocked)
      select ('e3310000-3333-4000-8000-'||lpad(i::text,12,'0'))::uuid, '${A}', 'c'||i, i % 5 = 0, i = 1 or i % 7 = 0
        from generate_series(1, 40) i;
    -- Status, dono e silêncio variados para cruzar com as travas do contato.
    insert into public.conversations(organization_id,contact_id,channel_session_id,status,assigned_to_user_id,bot_silenced_until)
      select '${A}', ('e3310000-3333-4000-8000-'||lpad(i::text,12,'0'))::uuid, '${CANAL}',
             case when i % 9 = 0 then 'closed' else 'open' end,
             case when i % 11 = 0 then '${GESTOR}'::uuid end,
             case when i % 6 = 0 then now() + interval '1 hour' when i % 13 = 0 then now() - interval '1 hour' end
        from generate_series(1, 40) i;
    ${ANTIGA}
  `);
});
afterAll(() => pool.end());

describe("0331 — comando_da_conversa sem reler o contato sob RLS", () => {
  it("devolve o mesmo que a definição anterior, conversa a conversa", async () => {
    await como<{ novo: string; velho: string }>(GESTOR, async (q) => {
      const { rows } = await q(
        `select public.comando_da_conversa(c) novo, antiga.comando_da_conversa(c) velho
           from public.conversations c where organization_id = $1`,
        [A],
      );
      expect(rows).toHaveLength(40);
      expect(rows.filter((r) => r.novo !== r.velho)).toEqual([]);
      expect(new Set(rows.map((r) => r.novo))).toEqual(new Set(["humano", "encerrada", "aguardando", "automatico"]));
    });
  });

  it("o contato bloqueado segura o robô para quem é da organização dele", async () => {
    await como<{ v: boolean }>(GESTOR, async (q) => {
      const { rows } = await q("select public.fn_contato_segura_o_robo($1) v", [BLOQUEADO]);
      expect(rows[0]!.v).toBe(true);
    });
  });

  it("para quem é de outra organização, o mesmo contato sai false", async () => {
    await como<{ v: boolean }>(OUTRO, async (q) => {
      const { rows } = await q("select public.fn_contato_segura_o_robo($1) v", [BLOQUEADO]);
      expect(rows[0]!.v).toBe(false);
    });
  });

  it("o servidor (sem usuário no JWT) lê a trava de qualquer organização", async () => {
    const { rows } = await pool.query("select public.fn_contato_segura_o_robo($1) v", [BLOQUEADO]);
    expect(rows[0].v).toBe(true);
  });

  it("0332: travar e soltar o contato chega às conversas dele, e conversa nova herda a trava", async () => {
    const LIVRE = "e3310000-3333-4000-8000-000000000002"; // i=2: nem force_human nem bloqueado
    const flag = async (id: string) =>
      (await pool.query("select bool_and(contato_segura_robo) v, count(*) n from public.conversations where contact_id = $1", [id])).rows[0];
    expect((await flag(LIVRE)).v).toBe(false);
    await pool.query("update public.contacts set force_human = true where id = $1", [LIVRE]);
    expect((await flag(LIVRE)).v).toBe(true);
    await pool.query("update public.contacts set force_human = false where id = $1", [LIVRE]);
    expect((await flag(LIVRE)).v).toBe(false);
    const NOVO_BLOQ = "e3310000-3333-4000-8000-000000000091";
    const NOVO_LIVRE = "e3310000-3333-4000-8000-000000000092";
    await pool.query(
      `insert into public.contacts(id,organization_id,display_name,is_blocked)
         values ($1,$3,'novo bloqueado',true), ($2,$3,'novo livre',false)`,
      [NOVO_BLOQ, NOVO_LIVRE, A],
    );
    const { rows } = await pool.query(
      `insert into public.conversations(organization_id,contact_id,channel_session_id,status)
         values ($1,$2,$3,'open') returning id, contato_segura_robo v, public.comando_da_conversa(conversations) c`,
      [A, NOVO_BLOQ, CANAL],
    );
    expect({ v: rows[0].v, c: rows[0].c }).toEqual({ v: true, c: "aguardando" });
    const troca = await pool.query(
      "update public.conversations set contact_id = $1 where id = $2 returning contato_segura_robo v",
      [NOVO_LIVRE, rows[0].id],
    );
    expect(troca.rows[0].v).toBe(false);
  });

  it("0332: as funções de gatilho não são alcançáveis pela REST", async () => {
    const { rows } = await pool.query(
      `select p.proname, has_function_privilege('authenticated', p.oid, 'execute') a, has_function_privilege('anon', p.oid, 'execute') n
         from pg_proc p where p.proname in ('fn_conversa_herda_trava_do_contato','fn_contato_propaga_trava') order by 1`,
    );
    expect(rows).toEqual([
      { proname: "fn_contato_propaga_trava", a: false, n: false },
      { proname: "fn_conversa_herda_trava_do_contato", a: false, n: false },
    ]);
  });

  it("anon não executa a função", async () => {
    const { rows } = await pool.query(
      "select has_function_privilege('anon','public.fn_contato_segura_o_robo(uuid)','execute') v",
    );
    expect(rows[0].v).toBe(false);
  });
});
