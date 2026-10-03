import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { seedGov, GOV_ORG as org, GOV_ADMIN as admin } from "./gov-helpers";

/**
 * Achado A5 (migration 0301): quem tem fator TOTP verificado precisa de sessão
 * `aal2` também na REST. Antes, a exigência só existia no Next, e um JWT `aal1`
 * lia as conversas da organização direto pelo PostgREST.
 */
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 3 });
const query = (text: string, args: unknown[] = []) => pool.query(text, args);
async function contarComo(user: string, aal: string, tabela: string): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal })]);
    const r = await c.query(`select count(*)::int n from public.${tabela} where organization_id=$1`, [org]);
    return r.rows[0].n;
  } finally { await c.query("rollback"); c.release(); }
}
const FATOR = "30000000-0000-4000-8000-0000000000a5";

beforeAll(() => seedGov());
afterAll(async () => { await query("delete from auth.mfa_factors where id=$1", [FATOR]); await pool.end(); });

describe("segundo fator vale na REST", () => {
  it("toda tabela de public com organization_id servida por policy tem a restritiva, exceto o vínculo", async () => {
    const r = await query(`
      select c.relname from pg_class c
        join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped
       where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and c.relname<>'user_organizations'
         and exists (select 1 from pg_policy q where q.polrelid=c.oid and q.polpermissive)
         and not exists (select 1 from pg_policy p where p.polrelid=c.oid and p.polname='mfa_provada' and not p.polpermissive)`);
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });

  it("sem fator, aal1 lê como antes; com fator, aal1 não lê nada e aal2 lê", async () => {
    const antes = await contarComo(admin, "aal1", "conversations");
    expect(antes).toBeGreaterThan(0);
    await query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp') on conflict do nothing", [FATOR, admin]);
    try {
      expect(await contarComo(admin, "aal1", "conversations")).toBe(0);
      expect(await contarComo(admin, "aal2", "conversations")).toBe(antes);
      // O vínculo continua legível antes do desafio, senão o login cai em "acesso revogado".
      expect(await contarComo(admin, "aal1", "user_organizations")).toBeGreaterThan(0);
    } finally {
      await query("delete from auth.mfa_factors where id=$1", [FATOR]);
    }
  });
});
