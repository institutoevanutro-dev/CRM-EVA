import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AGENDAMENTO EXCLUÍDO NÃO DÁ ACESSO DO PRESTADOR AO PACIENTE (migration 0365).
 *
 * `fn_provider_can_access_contact` é a função única que decide se o prestador
 * enxerga um paciente (policies de `contacts`, e por elas conversas e negócios).
 * Até a 0365 ela contava QUALQUER agendamento do prestador com o paciente, e um
 * agendamento lançado por engano seguia abrindo o paciente depois de excluído
 * (0364). Decisão do dono do produto: o excluído não conta. O cancelado comum
 * conta como sempre contou.
 *
 * Medido como o PostgREST fala com o banco: `authenticated` + o JWT do
 * prestador, pela função E pela leitura de `contacts` sob RLS.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

const ORG = randomUUID();
const OUTRA = randomUUID();
const GERENTE = randomUUID();
const PRESTADOR = randomUUID();
const PRESTADOR_DA_OUTRA = randomUUID();

const SO_EXCLUIDO = randomUUID();
const SO_CANCELADO = randomUUID();
const EXCLUIDO_E_VALIDO = randomUUID();
const PACIENTE_DA_OUTRA = randomUUID();

let hora = 0;
async function agendamento(org: string, dono: string, contato: string, cancelado = false): Promise<string> {
  hora += 2;
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments(organization_id,owner_user_id,contact_id,title,starts_at,ends_at,status,cancelled_at,cancellation_reason)
     values($1,$2,$3,'Consulta',date_trunc('hour',now())+make_interval(days=>12,hours=>$4::int),
            date_trunc('hour',now())+make_interval(days=>12,hours=>$4::int+1),
            case when $5 then 'cancelled' else 'confirmed' end,
            case when $5 then now() end, case when $5 then 'paciente desmarcou' end)
     returning id`,
    [org, dono, contato, hora, cancelado],
  );
  return rows[0]!.id;
}

async function como<T extends pg.QueryResultRow>(uid: string, sql: string, params: unknown[]) {
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

const podeAcessar = async (uid: string, org: string, contato: string) =>
  (await como<{ ok: boolean }>(uid, "select public.fn_provider_can_access_contact($1,$2) as ok", [org, contato]))
    .rows[0]!.ok;

const enxergaContato = async (uid: string, contato: string) =>
  (await como(uid, "select id from public.contacts where id=$1", [contato])).rowCount === 1;

beforeAll(async () => {
  for (const [id, nome] of [
    [ORG, "Acesso excluido"],
    [OUTRA, "Acesso outra"],
  ]) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,$2,$2)",
      [id, nome],
    );
  }
  for (const [uid, org, papel] of [
    [GERENTE, ORG, "manager"],
    [PRESTADOR, ORG, "provider"],
    [PRESTADOR_DA_OUTRA, OUTRA, "provider"],
  ]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [uid, `${uid}@acesso.test`]);
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
      [uid, org, papel],
    );
  }
  for (const [id, org] of [
    [SO_EXCLUIDO, ORG],
    [SO_CANCELADO, ORG],
    [EXCLUIDO_E_VALIDO, ORG],
    [PACIENTE_DA_OUTRA, OUTRA],
  ]) {
    await pool.query(
      `insert into contacts(id,organization_id,display_name,consent,tags,custom_fields)
       values($1,$2,'Paciente de teste','{}'::jsonb,'{}'::text[],'{}'::jsonb)`,
      [id, org],
    );
  }

  const excluir = (id: string) =>
    como(GERENTE, "select fn_appointment_exclude($1,$2,$3)", [ORG, id, "lançado por engano"]);

  await excluir(await agendamento(ORG, PRESTADOR, SO_EXCLUIDO));
  await agendamento(ORG, PRESTADOR, SO_CANCELADO, true);
  await excluir(await agendamento(ORG, PRESTADOR, EXCLUIDO_E_VALIDO));
  await agendamento(ORG, PRESTADOR, EXCLUIDO_E_VALIDO);
  await agendamento(OUTRA, PRESTADOR_DA_OUTRA, PACIENTE_DA_OUTRA);
});

describe("agendamento excluído não dá acesso ao paciente", () => {
  it("as fixtures são o que dizem ser", async () => {
    const { rows } = await pool.query<{ contact_id: string; status: string; excluido: boolean }>(
      `select contact_id, status, excluded_at is not null as excluido from calendar_appointments
        where contact_id = any($1::uuid[]) order by contact_id, excluido`,
      [[SO_EXCLUIDO, SO_CANCELADO, EXCLUIDO_E_VALIDO]],
    );
    const de = (c: string) => rows.filter((r) => r.contact_id === c).map((r) => `${r.status}:${r.excluido}`);
    expect(de(SO_EXCLUIDO)).toEqual(["cancelled:true"]);
    expect(de(SO_CANCELADO)).toEqual(["cancelled:false"]);
    expect(de(EXCLUIDO_E_VALIDO)).toEqual(["confirmed:false", "cancelled:true"]);
  });

  it("prestador com só um agendamento excluído perde o acesso", async () => {
    expect(await podeAcessar(PRESTADOR, ORG, SO_EXCLUIDO)).toBe(false);
    expect(await enxergaContato(PRESTADOR, SO_EXCLUIDO)).toBe(false);
  });

  it("agendamento cancelado (não excluído) segue como hoje: dá acesso", async () => {
    expect(await podeAcessar(PRESTADOR, ORG, SO_CANCELADO)).toBe(true);
    expect(await enxergaContato(PRESTADOR, SO_CANCELADO)).toBe(true);
  });

  it("outro agendamento válido mantém o acesso", async () => {
    expect(await podeAcessar(PRESTADOR, ORG, EXCLUIDO_E_VALIDO)).toBe(true);
    expect(await enxergaContato(PRESTADOR, EXCLUIDO_E_VALIDO)).toBe(true);
  });

  it("as duas organizações ficam isoladas", async () => {
    expect(await podeAcessar(PRESTADOR_DA_OUTRA, OUTRA, PACIENTE_DA_OUTRA)).toBe(true);
    expect(await enxergaContato(PRESTADOR_DA_OUTRA, PACIENTE_DA_OUTRA)).toBe(true);
    expect(await podeAcessar(PRESTADOR, OUTRA, PACIENTE_DA_OUTRA)).toBe(false);
    expect(await enxergaContato(PRESTADOR, PACIENTE_DA_OUTRA)).toBe(false);
    for (const c of [SO_CANCELADO, EXCLUIDO_E_VALIDO]) {
      expect(await podeAcessar(PRESTADOR_DA_OUTRA, ORG, c)).toBe(false);
      expect(await enxergaContato(PRESTADOR_DA_OUTRA, c)).toBe(false);
    }
  });
});
