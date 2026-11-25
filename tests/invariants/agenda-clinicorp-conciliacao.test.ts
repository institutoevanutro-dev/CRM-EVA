import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A CONCILIAÇÃO DA FOTO IMPORTADA COM O WEBHOOK DA CLINICORP (migration 0438) —
 * medida no Postgres, sob `set role` e JWT de verdade.
 *
 * O compromisso que veio no relatório importado (0435, sem id) e depois chega
 * pelo webhook (com id) não pode ocupar duas vezes, e o desmarcado tem de vagar.
 * `fn_agenda_clinicorp_conciliar` apaga da foto o horário cuja pessoa e começo a
 * cópia já conhece, em qualquer situação, e não depende da ordem: o evento que
 * chegou antes de o profissional ter pessoa é conciliado quando ela é ligada, e
 * a importação refeita volta a ser conciliada.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = randomUUID();
const VIZINHA = randomUUID();
const DONA = randomUUID();
const OUTRA_PESSOA = randomUUID();
const DA_VIZINHA = randomUUID();

const h = (hhmm: string) => `2030-06-03T${hhmm}:00.000Z`;
const JANELA = [h("00:00"), h("23:00")];

const CONCILIAR = "select public.fn_agenda_clinicorp_conciliar($1) as n";
const IMPORTAR = "select public.fn_agenda_clinicorp_importar($1, $2::jsonb) as n";
const EXTERNA = "select starts_at, ends_at from public.fn_agenda_ocupacao_externa_do_dono($1, $2, $3, $4) order by starts_at";

type Ator = { tipo: "usuario"; id: string } | { tipo: "anon" } | { tipo: "service_role" };

async function como(ator: Ator, sqlText: string, args: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const role = ator.tipo === "usuario" ? "authenticated" : ator.tipo;
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(ator.tipo === "usuario" ? { sub: ator.id, role } : { role }),
    ]);
    const r = await client.query(sqlText, args);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const servico: Ator = { tipo: "service_role" };
const foto = (org: string) =>
  pool
    .query("select user_id, starts_at from calendar_clinicorp_imported_events where organization_id = $1 order by user_id, starts_at", [org])
    .then((r) => r.rows.map((x) => `${x.user_id === DONA ? "dona" : x.user_id === OUTRA_PESSOA ? "outra" : "vizinha"}@${(x.starts_at as Date).toISOString().slice(11, 16)}`).sort());
const ocupacaoDaDona = () =>
  como({ tipo: "usuario", id: DONA }, EXTERNA, [ORG, DONA, ...JANELA]).then((r) =>
    r.rows.map((x) => `${(x.starts_at as Date).toISOString().slice(11, 16)}-${(x.ends_at as Date).toISOString().slice(11, 16)}`),
  );
const importacao = (linhas: Array<[string, string, string]>) =>
  JSON.stringify(linhas.map(([user_id, de, ate]) => ({ user_id, starts_at: h(de), ends_at: h(ate) })));

beforeAll(async () => {
  for (const id of [DONA, OUTRA_PESSOA, DA_VIZINHA]) {
    await pool.query("insert into auth.users(id, email) values ($1, $2)", [id, `${id}@invariant.test`]);
  }
  for (const [org, nome] of [[ORG, "Clinica"], [VIZINHA, "Vizinha"]] as const) {
    await pool.query("insert into organizations(id, slug, display_name, legal_name) values ($1, $2, $3, $3)", [
      org,
      `conciliacao-${org}`,
      nome,
    ]);
    await pool.query("insert into calendar_clinicorp_integrations(organization_id) values ($1)", [org]);
  }
  await pool.query(
    `insert into user_organizations(organization_id, user_id, role, accepted_at)
     values ($1, $2, 'agent', now()), ($1, $3, 'agent', now()), ($4, $5, 'admin', now())`,
    [ORG, DONA, OUTRA_PESSOA, VIZINHA, DA_VIZINHA],
  );

  // A foto: três horários da dona, um da outra pessoa, e um da vizinha no mesmo começo.
  await como(servico, IMPORTAR, [
    ORG,
    importacao([[DONA, "13:00", "14:00"], [DONA, "17:00", "18:00"], [DONA, "19:00", "20:00"], [OUTRA_PESSOA, "13:00", "14:00"]]),
  ]);
  await como(servico, IMPORTAR, [VIZINHA, importacao([[DA_VIZINHA, "13:00", "14:00"]])]);

  // O webhook: 9001 é a dona; 9002 ainda não tem pessoa. A vizinha também tem um 9001, ligado a ela.
  await pool.query(
    `insert into calendar_clinicorp_professionals(organization_id, professional_id, user_id)
     values ($1, '9001', $2), ($1, '9002', null), ($3, '9001', $4)`,
    [ORG, DONA, VIZINHA, DA_VIZINHA],
  );
  await como(servico, "select public.fn_agenda_clinicorp_gravar($1, $2::jsonb)", [
    ORG,
    JSON.stringify([
      // confirmou o que estava na foto
      { external_id: "1", professional_id: "9001", clinic_id: null, starts_at: h("13:00"), ends_at: h("14:00"), status: "confirmed" },
      // desmarcou o que estava na foto
      { external_id: "2", professional_id: "9001", clinic_id: null, starts_at: h("17:00"), ends_at: h("18:00"), status: "cancelled" },
      // profissional ainda sem pessoa
      { external_id: "3", professional_id: "9002", clinic_id: null, starts_at: h("19:00"), ends_at: h("20:00"), status: "confirmed" },
    ]),
  ]);
});

afterAll(() => pool.end());

describe("a conciliação", () => {
  it("antes dela, o confirmado ocupa duas vezes e o desmarcado segue ocupado pela foto", async () => {
    expect(await ocupacaoDaDona()).toEqual(["13:00-14:00", "13:00-14:00", "17:00-18:00", "19:00-20:00"]);
  });

  it("tira da foto o que a cópia conhece da MESMA pessoa no MESMO começo, desmarcado inclusive", async () => {
    expect((await como(servico, CONCILIAR, [ORG])).rows[0].n).toBe(2);
    expect(await foto(ORG)).toEqual(["dona@19:00", "outra@13:00"]);
    expect(await ocupacaoDaDona()).toEqual(["13:00-14:00", "19:00-20:00"]);
  });

  it("não alcança outra organização, nem a outra pessoa no mesmo começo", async () => {
    expect(await foto(VIZINHA)).toEqual(["vizinha@13:00"]);
    expect(await foto(ORG)).toContain("outra@13:00");
  });

  it("o evento que chegou antes da ligação é conciliado quando o profissional ganha pessoa", async () => {
    await pool.query("update calendar_clinicorp_professionals set user_id = $2 where organization_id = $1 and professional_id = '9002'", [ORG, DONA]);
    expect(await ocupacaoDaDona()).toEqual(["13:00-14:00", "19:00-20:00", "19:00-20:00"]);
    expect((await como(servico, CONCILIAR, [ORG])).rows[0].n).toBe(1);
    expect(await ocupacaoDaDona()).toEqual(["13:00-14:00", "19:00-20:00"]);
  });

  it("a importação refeita traz o horário de volta, e conciliar de novo o tira; sem nada a fazer, zero", async () => {
    await como(servico, IMPORTAR, [ORG, importacao([[DONA, "13:00", "14:00"], [DONA, "21:00", "22:00"]])]);
    expect((await como(servico, CONCILIAR, [ORG])).rows[0].n).toBe(1);
    expect(await ocupacaoDaDona()).toEqual(["13:00-14:00", "19:00-20:00", "21:00-22:00"]);
    expect((await como(servico, CONCILIAR, [ORG])).rows[0].n).toBe(0);
  });

  it("só o service role executa", async () => {
    await expect(como({ tipo: "anon" }, CONCILIAR, [ORG])).rejects.toMatchObject({ code: "42501" });
    await expect(como({ tipo: "usuario", id: DONA }, CONCILIAR, [ORG])).rejects.toMatchObject({ code: "42501" });
  });
});
