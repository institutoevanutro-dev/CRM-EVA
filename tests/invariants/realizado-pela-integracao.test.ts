/**
 * "Realizado" informado pela integração do prontuário (migration 0401).
 *
 * A presença era só declaração humana (0224). A 0401 abre UMA porta: a
 * service_role chamando fn_appointment_complete_by_integration registra
 * `completed` com outcome_source_kind='integration' e sem outcome_user_id.
 * Tudo o mais continua fechado: UPDATE direto sem sessão, falta pela
 * integração, sessão chamando a função, outra organização e compromisso futuro.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
const ORG = randomUUID();
const OUTRA = randomUUID();
const AGENT = randomUUID();

async function asRole(role: "authenticated" | "service_role", user: string | null, query: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, aal: "aal1", ...(user ? { sub: user } : {}) })]);
    const r = await client.query(query, values);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function compromisso(org: string, inicio = "now()-interval '2 hours'") {
  const contato = randomUUID(), id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Paciente Teste')", [contato, org]);
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status) values($1,$2,$3,'Consulta',${inicio},${inicio}+interval '1 hour','confirmed')`,
    [id, org, contato],
  );
  return id;
}
const pela_integracao = "select fn_appointment_complete_by_integration($1,$2,1) r";

beforeAll(async () => {
  for (const org of [ORG, OUTRA]) {
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Realizado','Realizado')", [org]);
  }
  await pool.query("insert into auth.users(id,email) values($1,$2)", [AGENT, `${AGENT}@invariant.test`]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())", [AGENT, ORG]);
});
afterAll(() => pool.end());

describe("realizado pela integração do prontuário (0401)", () => {
  it("service_role pela função registra completed com origem 'integration' e sem pessoa", async () => {
    const id = await compromisso(ORG);
    await asRole("service_role", null, pela_integracao, [ORG, id]);
    const { rows } = await pool.query("select status,outcome_source_kind,outcome_user_id,outcome_recorded_at from calendar_appointments where id=$1", [id]);
    expect(rows[0]).toMatchObject({ status: "completed", outcome_source_kind: "integration", outcome_user_id: null });
    expect(rows[0].outcome_recorded_at).not.toBeNull();
    const ev = await pool.query("select count(*)::int n from event_log where entity_id=$1 and event_type='appointment.attended'", [id]);
    expect(ev.rows[0].n, "o pós-consulta recebe o mesmo evento da presença humana").toBe(1);
  });

  it("UPDATE direto sem sessão continua barrado (a marca só existe dentro da função)", async () => {
    const id = await compromisso(ORG);
    await expect(asRole("service_role", null, "update calendar_appointments set status='completed' where id=$1", [id])).rejects.toThrow(/appointment_human_confirmation_required/);
    await expect(asRole("service_role", null, "select fn_appointment_change($1,$2,1,'{\"status\":\"completed\"}'::jsonb)", [ORG, id])).rejects.toThrow(/appointment_human_confirmation_required/);
  });

  it("falta não passa pela integração", async () => {
    const id = await compromisso(ORG);
    await expect(
      asRole("service_role", null, "select set_config('crm.realizado_pela_integracao','on',true); update calendar_appointments set status='no_show' where id=$1", [id]),
    ).rejects.toThrow();
    const { rows } = await pool.query("select status from calendar_appointments where id=$1", [id]);
    expect(rows[0].status).toBe("confirmed");
  });

  it("sessão de usuário não executa a função", async () => {
    const id = await compromisso(ORG);
    await expect(asRole("authenticated", AGENT, pela_integracao, [ORG, id])).rejects.toThrow(/permission denied|appointment_integration_only/);
  });

  it("compromisso de outra organização não é alcançado pelo id", async () => {
    const id = await compromisso(OUTRA);
    await expect(asRole("service_role", null, pela_integracao, [ORG, id])).rejects.toThrow(/appointment_not_found/);
  });

  it("compromisso que ainda não começou é recusado", async () => {
    const id = await compromisso(ORG, "now()+interval '1 day'");
    await expect(asRole("service_role", null, pela_integracao, [ORG, id])).rejects.toThrow(/appointment_not_started/);
  });

  it("anon e authenticated não têm EXECUTE", async () => {
    const { rows } = await pool.query(
      "select has_function_privilege('anon','public.fn_appointment_complete_by_integration(uuid,uuid,bigint)','execute') a, has_function_privilege('authenticated','public.fn_appointment_complete_by_integration(uuid,uuid,bigint)','execute') b",
    );
    expect(rows[0]).toEqual({ a: false, b: false });
  });
});
