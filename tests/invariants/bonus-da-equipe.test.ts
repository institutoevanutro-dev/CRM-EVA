import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BÔNUS DA EQUIPE (migration 0392), MEDIDO NO POSTGRES.
 *
 * O que só o banco prova: o gatilho das tarefas (hora de encerramento e trava do
 * prazo trocado depois de vencido), a RLS das três tabelas, a função que monta a
 * fila do dia e a redação LGPD do resumo das ligações. Nomes fictícios.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

const ORG = randomUUID();
const OUTRA = randomUUID();
const APROVADOR = randomUUID();
const PESSOA_A = randomUUID();
const PESSOA_B = randomUUID();
const ADMIN_DA_OUTRA = randomUUID();
const SESSAO = randomUUID();

beforeAll(async () => {
  for (const [id, nome] of [
    [ORG, "Bonus"],
    [OUTRA, "Outra"],
  ]) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,$2,$2,'America/Sao_Paulo')",
      [id, nome],
    );
  }
  for (const [uid, org, papel] of [
    [APROVADOR, ORG, "admin"],
    [PESSOA_A, ORG, "admin"],
    [PESSOA_B, ORG, "agent"],
    [ADMIN_DA_OUTRA, OUTRA, "admin"],
  ]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [uid, `${uid}@bonus.test`]);
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
      [uid, org, papel],
    );
  }
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
    [SESSAO, ORG, `bonus-${SESSAO.slice(0, 8)}`],
  );
});

/** SQL como o PostgREST faz: `authenticated` + o JWT em `request.jwt.claims`. */
async function como<T extends pg.QueryResultRow>(uid: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await c.query<T>(sql, params);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function tarefa(prazo: string | null, status = "pending"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_tasks(organization_id,title,due_date,status,assigned_to)
     values($1,'Tarefa de teste',${prazo ?? "null"},$2,$3) returning id`,
    [ORG, status, PESSOA_A],
  );
  return rows[0]!.id;
}

const lerTarefa = async (id: string) =>
  (
    await pool.query<{ closed_at: Date | null; missed_due_date: Date | null; due_date: Date | null }>(
      "select closed_at, missed_due_date, due_date from crm_tasks where id=$1",
      [id],
    )
  ).rows[0]!;

/** 23h59 de HOJE no relógio de São Paulo: o fim do dia ainda não passou. */
const HOJE_23H59 =
  "((date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '23 hours 59 minutes') at time zone 'America/Sao_Paulo')";
const ANTEONTEM = "now() - interval '2 days'";
const DAQUI_A_3_DIAS = "now() + interval '3 days'";

describe("tarefas: hora do encerramento", () => {
  it("concluir grava closed_at; reabrir apaga", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS);
    await pool.query("update crm_tasks set status='done' where id=$1", [id]);
    expect((await lerTarefa(id)).closed_at).not.toBeNull();
    await pool.query("update crm_tasks set status='pending' where id=$1", [id]);
    expect((await lerTarefa(id)).closed_at).toBeNull();
  });

  it("cancelar também grava a hora (a cancelada depois do prazo conta como atrasada)", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS);
    await pool.query("update crm_tasks set status='cancelled' where id=$1", [id]);
    expect((await lerTarefa(id)).closed_at).not.toBeNull();
  });

  it("closed_at não é forjável pela sessão: o gatilho ignora o valor enviado", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS);
    await como(PESSOA_A, "update crm_tasks set status='done', closed_at='2020-01-01T00:00:00Z' where id=$1", [id]);
    const lida = await lerTarefa(id);
    expect(lida.closed_at!.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("tarefa criada já concluída nasce com closed_at", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS, "done");
    expect((await lerTarefa(id)).closed_at).not.toBeNull();
  });
});

describe("tarefas: prazo trocado depois de vencido", () => {
  it("prazo vencido (anteontem) trocado para o futuro guarda o prazo original", async () => {
    const id = await tarefa(ANTEONTEM);
    const antes = await lerTarefa(id);
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    const depois = await lerTarefa(id);
    expect(depois.missed_due_date?.toISOString()).toBe(antes.due_date?.toISOString());
  });

  it("trocar o prazo no PRÓPRIO dia do vencimento não é atraso (o fim do dia não passou)", async () => {
    const id = await tarefa(HOJE_23H59);
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    expect((await lerTarefa(id)).missed_due_date).toBeNull();
  });

  it("a marca não se apaga: nem a sessão nem uma segunda troca a zeram", async () => {
    const id = await tarefa(ANTEONTEM);
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    const original = (await lerTarefa(id)).missed_due_date!.toISOString();
    const r = await como(
      PESSOA_A,
      "update crm_tasks set missed_due_date=null, due_date=now() + interval '9 days' where id=$1",
      [id],
    );
    expect(r.rowCount).toBe(1);
    const lida = await lerTarefa(id);
    expect(lida.due_date!.getTime()).toBeGreaterThan(Date.now() + 8 * 86_400_000);
    expect(lida.missed_due_date!.toISOString()).toBe(original);
  });

  it("fuso inválido na organização não derruba a troca: usa o fuso padrão", async () => {
    const org = randomUUID();
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Fuso','Fuso','Invalida/Zona')",
      [org],
    );
    const { rows } = await pool.query<{ id: string; due_date: Date }>(
      `insert into crm_tasks(organization_id,title,due_date,status)
       values($1,'Tarefa de teste',${ANTEONTEM},'pending') returning id, due_date`,
      [org],
    );
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [rows[0]!.id]);
    expect((await lerTarefa(rows[0]!.id)).missed_due_date?.toISOString()).toBe(rows[0]!.due_date.toISOString());
  });

  it("tarefa já concluída pode ter o prazo editado sem virar atrasada", async () => {
    const id = await tarefa(ANTEONTEM, "done");
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    expect((await lerTarefa(id)).missed_due_date).toBeNull();
  });
});
