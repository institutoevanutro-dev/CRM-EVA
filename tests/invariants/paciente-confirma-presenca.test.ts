/**
 * O paciente confirma a presença (migration 0441).
 *
 * "Presença confirmada" é marca separada do status, gravada só por
 * fn_appointment_patient_confirm (service_role). Ela grava em compromisso
 * `confirmed`, futuro e na revisão esperada, uma vez só, sem mexer na revisão.
 * Remarcar (starts_at muda) apaga a marca no mesmo UPDATE, e a revisão antiga
 * deixa de valer. Passado, pendente e cancelado nunca são confirmados.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarOrigemDeFollowup } from "./followup-service-origin";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
const ORG = randomUUID();
const RECEPCAO = randomUUID();
const ASSINATURA = "public.fn_appointment_patient_confirm(uuid,int,text,uuid,uuid)";

async function comoServiceRole(query: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
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

/** Paciente com conversa e um "SIM" recebido dele. */
async function paciente() {
  const contato = (
    await pool.query("insert into contacts(organization_id,display_name) values($1,'Paciente Teste') returning id", [ORG])
  ).rows[0].id as string;
  const { conversation_id } = await criarOrigemDeFollowup(pool, ORG, contato);
  const sim = (
    await pool.query(
      `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via)
       select $1,id,channel_session_id,$2,'text','inbound','delivered','SIM','external_device' from conversations where id=$3
       returning id`,
      [ORG, contato, conversation_id],
    )
  ).rows[0].id as string;
  return { contato, sim };
}

async function compromisso(contato: string, inicio = "now()+interval '1 day'", status = "confirmed") {
  const id = randomUUID();
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status,cancelled_at)
     values($1,$2,$3,'Consulta',${inicio},${inicio}+interval '1 hour',$4,case when $4::text='cancelled' then now() end)`,
    [id, ORG, contato, status],
  );
  return id;
}

const confirmarPorMensagem = (id: string, revisao: number, msg: string) =>
  comoServiceRole("select fn_appointment_patient_confirm($1,$2,'mensagem',$3,null) r", [id, revisao, msg]).then(
    (q) => q.rows[0].r as string,
  );

async function marca(id: string) {
  const { rows } = await pool.query(
    `select revision::int, patient_confirmed_at, patient_confirmed_source, patient_confirmed_message_id, patient_confirmed_user_id
       from calendar_appointments where id=$1`,
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Confirma','Confirma')",
    [ORG],
  );
  await pool.query("insert into auth.users(id,email) values($1,$2)", [RECEPCAO, `${RECEPCAO}@invariant.test`]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())", [
    RECEPCAO,
    ORG,
  ]);
});
afterAll(() => pool.end());

describe("paciente confirma a presença (0441)", () => {
  it("grava uma vez, com a mensagem como prova, e não mexe na revisão", async () => {
    const { contato, sim } = await paciente();
    const id = await compromisso(contato);

    expect(await confirmarPorMensagem(id, 1, sim)).toBe("confirmado");
    const depois = await marca(id);
    expect(depois).toMatchObject({
      revision: 1,
      patient_confirmed_source: "mensagem",
      patient_confirmed_message_id: sim,
      patient_confirmed_user_id: null,
    });
    expect(depois.patient_confirmed_at).not.toBeNull();

    expect(await confirmarPorMensagem(id, 1, sim), "o segundo SIM não regrava").toBe("ja_confirmado");
    expect((await marca(id)).patient_confirmed_at).toEqual(depois.patient_confirmed_at);
  });

  it("pela equipe grava a pessoa, não mensagem", async () => {
    const { contato } = await paciente();
    const id = await compromisso(contato);
    const { rows } = await comoServiceRole(`select fn_appointment_patient_confirm($1,1,'equipe',null,$2) r`, [id, RECEPCAO]);
    expect(rows[0].r).toBe("confirmado");
    expect(await marca(id)).toMatchObject({
      patient_confirmed_source: "equipe",
      patient_confirmed_user_id: RECEPCAO,
      patient_confirmed_message_id: null,
    });
  });

  it("remarcar apaga a confirmação; a revisão antiga não confirma mais, a nova sim", async () => {
    const { contato, sim } = await paciente();
    const id = await compromisso(contato);
    expect(await confirmarPorMensagem(id, 1, sim)).toBe("confirmado");

    await pool.query("update calendar_appointments set notes='trazer exames' where id=$1", [id]);
    expect((await marca(id)).patient_confirmed_at, "mudar outra coisa não apaga").not.toBeNull();

    await pool.query(
      "update calendar_appointments set starts_at=starts_at+interval '2 hours', ends_at=ends_at+interval '2 hours' where id=$1",
      [id],
    );
    expect(await marca(id)).toMatchObject({
      revision: 2,
      patient_confirmed_at: null,
      patient_confirmed_source: null,
      patient_confirmed_message_id: null,
      patient_confirmed_user_id: null,
    });

    expect(await confirmarPorMensagem(id, 1, sim), "SIM ao lembrete do horário antigo").toBe("nao_se_aplica");
    expect((await marca(id)).patient_confirmed_at).toBeNull();
    expect(await confirmarPorMensagem(id, 2, sim)).toBe("confirmado");
  });

  it("compromisso passado, pendente ou cancelado não é confirmado", async () => {
    const { contato, sim } = await paciente();
    const passado = await compromisso(contato, "now()-interval '2 hours'");
    const pendente = await compromisso(contato, "now()+interval '2 days'", "pending");
    const cancelado = await compromisso(contato, "now()+interval '3 days'", "cancelled");
    for (const id of [passado, pendente, cancelado]) {
      expect(await confirmarPorMensagem(id, 1, sim)).toBe("nao_se_aplica");
      expect((await marca(id)).patient_confirmed_at).toBeNull();
    }
  });

  it("mensagem de outro paciente não é prova", async () => {
    const { contato } = await paciente();
    const { sim: doOutro } = await paciente();
    const id = await compromisso(contato);
    await expect(confirmarPorMensagem(id, 1, doOutro)).rejects.toThrow(/patient_confirm_message_not_evidence/);
    expect((await marca(id)).patient_confirmed_at).toBeNull();
  });

  it("anon e authenticated não executam; service_role executa", async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('anon',$1,'execute') a, has_function_privilege('authenticated',$1,'execute') b,
              has_function_privilege('service_role',$1,'execute') s`,
      [ASSINATURA],
    );
    expect(rows[0]).toEqual({ a: false, b: false, s: true });
  });
});
