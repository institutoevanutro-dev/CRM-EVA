import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A FOTO IMPORTADA DO RELATÓRIO DA CLINICORP (migration 0435) — medida no
 * Postgres, sob `set role` e JWT de verdade.
 *
 * 1. A importação substitui a foto anterior inteira, numa chamada; linha
 *    repetida entra uma vez; só o service role executa.
 * 2. `fn_agenda_ocupacao_externa_do_dono` devolve a foto da PESSOA pedida, como
 *    "clinicorp", para dono e gestor da organização; outra pessoa e outra
 *    organização recebem zero.
 * 3. Membro nenhum lê a tabela crua; desligar a integração leva a foto junto.
 *
 * Quem não importou nada (o Instituto) segue com a mesma resposta: os casos de
 * `agenda-ocupacao-da-clinicorp.test.ts` (Google sem Clinicorp, Clinicorp pela
 * API) rodam contra a função recriada aqui e continuam iguais.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = randomUUID();
const VIZINHA = randomUUID();
const DONA = randomUUID();
const GESTOR = randomUUID();
const DA_VIZINHA = randomUUID();

const INICIO = "2030-05-06T13:00:00.000Z";
const FIM = "2030-05-06T14:30:00.000Z";
const JANELA = ["2030-05-06T12:00:00.000Z", "2030-05-06T20:00:00.000Z"];

const IMPORTAR = "select public.fn_agenda_clinicorp_importar($1, $2::jsonb) as n";
const EXTERNA = "select * from public.fn_agenda_ocupacao_externa_do_dono($1, $2, $3, $4) order by starts_at";

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

const usuario = (id: string): Ator => ({ tipo: "usuario", id });
const servico: Ator = { tipo: "service_role" };
const item = (over: Record<string, unknown> = {}) => ({ user_id: DONA, starts_at: INICIO, ends_at: FIM, ...over });

beforeAll(async () => {
  for (const id of [DONA, GESTOR, DA_VIZINHA]) {
    await pool.query("insert into auth.users(id, email) values ($1, $2)", [id, `${id}@invariant.test`]);
  }
  for (const [org, nome] of [[ORG, "Clinica"], [VIZINHA, "Vizinha"]] as const) {
    await pool.query("insert into organizations(id, slug, display_name, legal_name) values ($1, $2, $3, $3)", [
      org,
      `importacao-${org}`,
      nome,
    ]);
  }
  await pool.query(
    `insert into user_organizations(organization_id, user_id, role, accepted_at)
     values ($1, $2, 'agent', now()), ($1, $3, 'manager', now()), ($4, $5, 'admin', now())`,
    [ORG, DONA, GESTOR, VIZINHA, DA_VIZINHA],
  );
  await pool.query("insert into calendar_clinicorp_integrations(organization_id) values ($1)", [ORG]);
});

afterAll(() => pool.end());

describe("a importação", () => {
  it("substitui a foto anterior inteira; linha repetida entra uma vez", async () => {
    const primeira = await como(servico, IMPORTAR, [ORG, JSON.stringify([item({ starts_at: "2030-05-07T13:00:00Z", ends_at: "2030-05-07T14:00:00Z" })])]);
    expect(primeira.rows[0].n).toBe(1);
    const segunda = await como(servico, IMPORTAR, [ORG, JSON.stringify([item(), item()])]);
    expect(segunda.rows[0].n).toBe(1);
    const r = await pool.query("select starts_at, ends_at from calendar_clinicorp_imported_events where organization_id = $1", [ORG]);
    expect(r.rows).toEqual([{ starts_at: new Date(INICIO), ends_at: new Date(FIM) }]);
  });

  it("só o service role executa", async () => {
    await expect(como({ tipo: "anon" }, IMPORTAR, [ORG, "[]"])).rejects.toMatchObject({ code: "42501" });
    await expect(como(usuario(GESTOR), IMPORTAR, [ORG, "[]"])).rejects.toMatchObject({ code: "42501" });
  });

  it("organização sem a integração da Clinicorp não recebe foto", async () => {
    await expect(como(servico, IMPORTAR, [VIZINHA, JSON.stringify([item()])])).rejects.toMatchObject({ code: "23503" });
  });
});

describe("a ocupação externa do dono", () => {
  it("devolve a foto da pessoa pedida, como clinicorp, para ela e para o gestor", async () => {
    for (const leitor of [DONA, GESTOR]) {
      const r = await como(usuario(leitor), EXTERNA, [ORG, DONA, ...JANELA]);
      expect(r.rows).toEqual([
        {
          starts_at: new Date(INICIO),
          ends_at: new Date(FIM),
          transparency: "opaque",
          status: "confirmed",
          connection_status: "healthy",
          fonte: "clinicorp",
        },
      ]);
    }
  });

  it("outra pessoa e outra organização recebem zero, mesmo passando o p_org certo", async () => {
    expect((await como(usuario(GESTOR), EXTERNA, [ORG, GESTOR, ...JANELA])).rows).toEqual([]);
    expect((await como(usuario(DA_VIZINHA), EXTERNA, [ORG, DONA, ...JANELA])).rows).toEqual([]);
  });

  it("encostar não é ocupar", async () => {
    expect((await como(usuario(DONA), EXTERNA, [ORG, DONA, FIM, "2030-05-06T20:00:00Z"])).rows).toEqual([]);
  });
});

describe("a tabela crua", () => {
  it("membro nenhum lê", async () => {
    for (const leitor of [GESTOR, DA_VIZINHA]) {
      await expect(
        como(usuario(leitor), "select * from calendar_clinicorp_imported_events", []),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("desligar a integração leva a foto junto", async () => {
    await pool.query("delete from calendar_clinicorp_integrations where organization_id = $1", [ORG]);
    const r = await pool.query("select count(*)::int as n from calendar_clinicorp_imported_events where organization_id = $1", [ORG]);
    expect(r.rows[0].n).toBe(0);
  });
});
