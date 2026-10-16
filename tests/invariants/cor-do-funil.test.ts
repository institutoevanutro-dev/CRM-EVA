import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A COR DO FUNIL (migration 0371): `crm_pipelines.color`.
 *
 *   C1  a forma é a do CHECK da etapa: #rrggbb (qualquer caixa) ou NULL
 *   C2  funil existente nasce sem cor (nada é tocado)
 *   C3  isolamento: a sessão de um gerente da organização A não pinta funil da B
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG_A = "c0f0f000-0000-4000-8000-00000000000a";
const ORG_B = "c0f0f000-0000-4000-8000-00000000000b";
const GERENTE_A = "c0f0f111-0000-4000-8000-000000000001";

async function funilDe(org: string): Promise<{ id: string; color: string | null }> {
  const { rows } = await pool.query<{ id: string; color: string | null }>(
    "select id, color from crm_pipelines where organization_id = $1 order by position limit 1",
    [org],
  );
  return rows[0]!;
}

beforeAll(async () => {
  await pool.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
    GERENTE_A,
    `${GERENTE_A}@cor-do-funil.test`,
  ]);
  for (const [org, slug] of [
    [ORG_A, "cor-do-funil-a"],
    [ORG_B, "cor-do-funil-b"],
  ] as const) {
    // O gatilho de organização nova semeia o funil padrão de cada uma.
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Clínica LTDA', 'Clínica') on conflict (id) do nothing`,
      [org, slug],
    );
  }
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, 'manager', now()) on conflict do nothing`,
    [GERENTE_A, ORG_A],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("cor do funil", () => {
  it("C2 · o funil semeado nasce sem cor", async () => {
    expect((await funilDe(ORG_A)).color).toBeNull();
  });

  it("C1 · aceita #rrggbb em qualquer caixa e NULL; recusa o resto", async () => {
    const { id } = await funilDe(ORG_A);
    for (const boa of ["#378ADD", "#378add", null]) {
      await pool.query("update crm_pipelines set color = $2 where id = $1", [id, boa]);
      expect((await funilDe(ORG_A)).color).toBe(boa);
    }
    for (const ruim of ["378ADD", "#378AD", "#GGGGGG", "azul", "", "#378ADDFF"]) {
      await expect(pool.query("update crm_pipelines set color = $2 where id = $1", [id, ruim]), ruim).rejects.toMatchObject({
        code: "23514",
      });
    }
  });

  it("C3 · a sessão de um gerente da A não pinta o funil da B", async () => {
    const daB = await funilDe(ORG_B);
    const daA = await funilDe(ORG_A);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: GERENTE_A, role: "authenticated", aal: "aal1" }),
      ]);
      const fora = await c.query("update crm_pipelines set color = '#D4537E' where id = $1", [daB.id]);
      const dentro = await c.query("update crm_pipelines set color = '#D4537E' where id = $1", [daA.id]);
      await c.query("commit");
      expect(fora.rowCount).toBe(0);
      expect(dentro.rowCount).toBe(1);
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
    expect((await funilDe(ORG_B)).color).toBeNull();
    expect((await funilDe(ORG_A)).color).toBe("#D4537E");
  });
});
