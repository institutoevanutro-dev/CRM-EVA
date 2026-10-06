import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { importarHistorico } from "@/lib/agenda/importar-historico";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode pnpm test:db");
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres` });
const org = randomUUID(), outra = randomUUID(), ator = randomUUID(), contato = randomUUID(), estranho = randomUUID();
const entrada = { organization_id: org, owner_user_id: ator, actor_user_id: ator,
  rows: ["completed", "confirmed", "pending", "no_show"].map((status, i) => ({
    key: String(i + 1).repeat(64), contact_id: contato, title: "Atendimento de teste",
    starts_at: `2020-04-0${i + 1}T10:00:00-03:00`, ends_at: `2020-04-0${i + 1}T11:00:00-03:00`, status,
  })) };
beforeAll(async () => {
  await pool.query("insert into auth.users(id,email) values($1,'history@example.test')", [ator]);
  for (const id of [org, outra]) await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,settings) values($1::uuid,$1::text,'Teste','Teste','{"crm":{"cliente_pela_agenda":true}}')`, [id]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())", [ator,org]);
  await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Pessoa teste'),($3,$4,'Outra pessoa')", [contato,org,estranho,outra]);
});
afterAll(() => pool.end());
it("prévia, replay, isolamento, conflito atômico e ausência de efeitos externos", async () => {
  const antes = (await pool.query("select count(*)::int n from event_log where organization_id=$1",[org])).rows[0].n;
  expect((await importarHistorico(pool, entrada)).map(x=>x.resultado)).toEqual(["novo","novo","novo","novo"]);
  expect((await pool.query("select count(*)::int n from calendar_appointments where organization_id=$1",[org])).rows[0].n).toBe(0);
  await expect(importarHistorico(pool, {...entrada,rows:[{...entrada.rows[0],contact_id:estranho}]},true)).rejects.toThrow("outra organização");
  const salvo = await importarHistorico(pool, entrada,true);
  expect(salvo.every(x=>x.id)).toBe(true);
  expect((await importarHistorico(pool,entrada,true)).every(x=>x.resultado==="existente")).toBe(true);
  const rows = (await pool.query("select status,needs_google_push,meeting_state,history_import_key from calendar_appointments where organization_id=$1 order by starts_at",[org])).rows;
  expect(rows.map(r=>r.status)).toEqual(["completed","confirmed","pending","no_show"]);
  expect(rows.every(r=>!r.needs_google_push && r.meeting_state==="not_requested" && r.history_import_key)).toBe(true);
  expect((await pool.query("select count(*)::int n from api_audit_log where organization_id=$1 and action='agenda.historico_importado'",[org])).rows[0].n).toBe(4);
  expect((await pool.query("select count(*)::int n from event_log where organization_id=$1",[org])).rows[0].n).toBe(antes);
  await pool.query("select fn_appointment_confirmation_sweep(500,now())");
  expect((await pool.query("select count(*)::int n from agent_inbox_items where organization_id=$1",[org])).rows[0].n).toBe(0);
  expect((await pool.query("select count(*)::int n from job_queue where organization_id=$1",[org])).rows[0].n).toBe(0);
  const conflito = {...entrada,rows:[{...entrada.rows[0]!,key:"a".repeat(64),starts_at:"2020-05-01T10:00:00-03:00",ends_at:"2020-05-01T11:00:00-03:00"},{...entrada.rows[0]!,status:"no_show"}]};
  await expect(importarHistorico(pool,conflito,true)).rejects.toThrow("Conflitos");
  expect((await pool.query("select count(*)::int n from calendar_appointments where organization_id=$1",[org])).rows[0].n).toBe(4);
  await expect(pool.query("update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where id=$1",[salvo[0]!.id])).rejects.toMatchObject({code:"42501"});
  await expect(importarHistorico(pool,{...entrada,organization_id:outra},true)).rejects.toThrow("gestor ativo");
  await expect(pool.query("update calendar_appointments set google_conflict='{\"resolution\":{\"choice\":\"local\"}}'::jsonb where id=$1",[salvo[0]!.id])).rejects.toMatchObject({code:"22023"});
  const db = await pool.connect();
  try {
    await db.query("begin;set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ator,role:"authenticated",aal:"aal1"})]);
    await expect(db.query(`insert into calendar_appointments(organization_id,owner_user_id,contact_id,title,starts_at,ends_at,status,source,history_import_key)
      values($1,$2,$3,'Teste','2020-01-01','2020-01-02','completed','historical_import',$4)`,[org,ator,contato,"e".repeat(64)])).rejects.toMatchObject({code:"42501"});
  } finally {await db.query("rollback");db.release();}
});
