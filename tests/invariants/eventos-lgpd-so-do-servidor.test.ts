import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedGov, GOV_VIEWER } from "./gov-helpers";

/**
 * `emit_event` está concedida a `authenticated` e só exigia papel `viewer`.
 * Um viewer emitia `lgpd.redact_received` pela REST e o `lgpd-redact-worker`
 * anonimizava o contato sem a aprovação de um manager (migration 0284).
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
const org = randomUUID();

beforeAll(async () => {
  await seedGov();
  await pool.query(
    "insert into organizations(id,slug,display_name,legal_name) values($1,$2,'LGPD evento','LGPD evento')",
    [org, `lgpd-evento-${org}`],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'viewer',now())",
    [org, GOV_VIEWER],
  );
});
afterAll(() => pool.end());

async function comoViewer(tipo: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GOV_VIEWER, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await client.query("select public.emit_event($1,'lgpd_request',$2,'{}'::jsonb,'{}'::jsonb,$3) as id", [
      tipo,
      randomUUID(),
      org,
    ]);
    await client.query("rollback");
    return r.rows[0].id as string;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

it.each(["lgpd.redact_received", "lgpd.data_request_received", "lgpd.redact_applied"])(
  "viewer não emite %s",
  async (tipo) => {
    await expect(comoViewer(tipo)).rejects.toMatchObject({ code: "42501", message: "reserved_lgpd_event" });
  },
);

it("viewer também não emite evento comum (0299)", async () => {
  await expect(comoViewer("contact.tag_added")).rejects.toMatchObject({ code: "42501", message: "caller_not_authorized_for_org" });
});

it("o servidor (service role, sem auth.uid) continua emitindo lgpd.*", async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await client.query(
      "select public.emit_event('lgpd.redact_received','lgpd_request',$1,'{}'::jsonb,'{}'::jsonb,$2) as id",
      [randomUUID(), org],
    );
    expect(r.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await client.query("rollback");
    client.release();
  }
});
