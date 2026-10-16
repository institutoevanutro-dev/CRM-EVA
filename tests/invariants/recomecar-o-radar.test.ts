import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * RECOMEÇAR O RADAR (migration 0370): `fn_definir_inicio_do_radar` grava ou
 * limpa `organizations.settings.radar.desde`.
 *
 * Invariante de banco porque o que importa só existe no Postgres:
 *
 *   R1  só admin da própria organização (ou super-admin) recomeça; manager,
 *       agent, viewer, admin de OUTRA organização e ator desconhecido levam 42501
 *       e não mudam nada
 *   R2  a gravação é só da chave: o resto de `settings` (o provedor de IA mora
 *       nele) e o resto de `settings.radar` sobrevivem
 *   R3  o instante é o relógio do BANCO, em UTC com milissegundos
 *   R4  recomeçar de novo move o instante; desfazer limpa; desfazer de novo não muda
 *   R5  isolamento: mexer na organização A não toca a B
 *   R6  privilégio: só service_role executa (anon e authenticated não)
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

const ORG_A = "5ada7000-0000-4000-8000-00000000000a";
const ORG_B = "5ada7000-0000-4000-8000-00000000000b";
const ADMIN_A = "5ada7111-0000-4000-8000-000000000001";
const MANAGER_A = "5ada7111-0000-4000-8000-000000000002";
const AGENT_A = "5ada7111-0000-4000-8000-000000000003";
const VIEWER_A = "5ada7111-0000-4000-8000-000000000004";
const ADMIN_B = "5ada7111-0000-4000-8000-000000000005";
const ESTRANHO = "5ada7111-0000-4000-8000-000000000006";

interface Resultado {
  desde: string | null;
  antes: string | null;
  mudou: boolean;
}

/** Chama como a rota chama: papel service_role, sem usuário no JWT. */
async function definir(org: string, ator: string, recomecar: boolean): Promise<Resultado> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    const r = await c.query<{ r: Resultado }>("select fn_definir_inicio_do_radar($1, $2, $3) as r", [
      org,
      ator,
      recomecar,
    ]);
    await c.query("commit");
    return r.rows[0]!.r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function settingsDe(org: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ settings: Record<string, unknown> }>(
    "select settings from organizations where id = $1",
    [org],
  );
  return rows[0]!.settings;
}

const SETTINGS_INICIAIS = {
  visibility_mode: "all",
  llm: { provider: "anthropic", model: "x" },
  radar: { outra_chave: true },
};

beforeAll(async () => {
  for (const u of [ADMIN_A, MANAGER_A, AGENT_A, VIEWER_A, ADMIN_B, ESTRANHO]) {
    await pool.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
      u,
      `${u}@recomecar-o-radar.test`,
    ]);
  }
  for (const [org, slug] of [
    [ORG_A, "recomecar-radar-a"],
    [ORG_B, "recomecar-radar-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, settings)
       values ($1, $2, 'Clínica LTDA', 'Clínica', $3::jsonb)
       on conflict (id) do update set settings = excluded.settings`,
      [org, slug, JSON.stringify(SETTINGS_INICIAIS)],
    );
  }
  for (const [u, org, papel] of [
    [ADMIN_A, ORG_A, "admin"],
    [MANAGER_A, ORG_A, "manager"],
    [AGENT_A, ORG_A, "agent"],
    [VIEWER_A, ORG_A, "viewer"],
    [ADMIN_B, ORG_B, "admin"],
  ] as const) {
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
       values ($1, $2, $3, now()) on conflict do nothing`,
      [u, org, papel],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("recomeçar o radar", () => {
  it("R1 · quem não é admin da organização leva 42501 e nada muda", async () => {
    for (const ator of [MANAGER_A, AGENT_A, VIEWER_A, ADMIN_B, ESTRANHO]) {
      await expect(definir(ORG_A, ator, true), ator).rejects.toMatchObject({ code: "42501" });
    }
    expect(await settingsDe(ORG_A)).toEqual(SETTINGS_INICIAIS);
  });

  it("R2/R3 · admin recomeça: grava só a chave, com o relógio do banco", async () => {
    const { rows } = await pool.query<{ agora: Date }>("select now() as agora");
    const r = await definir(ORG_A, ADMIN_A, true);
    expect(r.mudou).toBe(true);
    expect(r.antes).toBeNull();
    expect(r.desde).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(r.desde!) - rows[0]!.agora.getTime())).toBeLessThan(60_000);

    const settings = await settingsDe(ORG_A);
    expect(settings).toEqual({
      ...SETTINGS_INICIAIS,
      radar: { outra_chave: true, desde: r.desde },
    });
  });

  it("R4 · recomeçar de novo move o instante; desfazer limpa; desfazer de novo não muda", async () => {
    const primeiro = (await settingsDe(ORG_A)).radar as { desde: string };
    await pool.query("select pg_sleep(0.01)");
    const segundo = await definir(ORG_A, ADMIN_A, true);
    expect(segundo.antes).toBe(primeiro.desde);
    expect(Date.parse(segundo.desde!)).toBeGreaterThan(Date.parse(primeiro.desde));

    const desfeito = await definir(ORG_A, ADMIN_A, false);
    expect(desfeito).toEqual({ desde: null, antes: segundo.desde, mudou: true });
    expect(await settingsDe(ORG_A)).toEqual(SETTINGS_INICIAIS);

    expect(await definir(ORG_A, ADMIN_A, false)).toEqual({ desde: null, antes: null, mudou: false });
  });

  it("R5 · a organização B não é tocada pelo que acontece na A", async () => {
    await definir(ORG_A, ADMIN_A, true);
    expect(await settingsDe(ORG_B)).toEqual(SETTINGS_INICIAIS);
    const daA = await settingsDe(ORG_A);
    expect((await definir(ORG_B, ADMIN_B, true)).mudou).toBe(true);
    expect(await settingsDe(ORG_A)).toEqual(daA);
  });

  it("R6 · só service_role executa", async () => {
    const { rows } = await pool.query<{ anon: boolean; auth: boolean; servico: boolean; publico: boolean }>(
      `select has_function_privilege('anon', p, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p, 'EXECUTE') as auth,
              has_function_privilege('service_role', p, 'EXECUTE') as servico,
              exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico
         from (select 'public.fn_definir_inicio_do_radar(uuid, uuid, boolean)'::regprocedure as p) x
         join pg_proc on pg_proc.oid = x.p`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, servico: true, publico: false });
  });
});
