import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O CANAL INSTAGRAM NO SCHEMA (migration 0277).
 *
 * O que só o Postgres pode responder: a constraint de referência do provider
 * (`meta_instagram` exige `ig_account_id`), o vocabulário novo de
 * `conversations_channel_check`, a idempotência e o isolamento por
 * organização do upsert de identidade, o privilégio das duas RPCs novas
 * (nenhuma alcançável por `anon`/`authenticated` — são chamadas só pelo
 * webhook, com service role) e a RLS de `contact_channel_identities`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_A = "1657a000-0000-4000-8000-000000000001";
const ORG_B = "1657a000-0000-4000-8000-000000000002";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-instagram-canal-a', 'Instagram Canal LTDA A', 'Instagram Canal A')
     on conflict (id) do nothing`,
    [ORG_A],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-instagram-canal-b', 'Instagram Canal LTDA B', 'Instagram Canal B')
     on conflict (id) do nothing`,
    [ORG_B],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("channel_sessions aceita meta_instagram só com ig_account_id", () => {
  it("recusa meta_instagram sem ig_account_id", async () => {
    await expect(
      pool.query(
        `insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted)
         values ($1, 'meta_instagram', 'WORKING', decode('00','hex'))`,
        [ORG_A],
      ),
    ).rejects.toThrow(/channel_sessions_provider_ref_check/);
  });

  it("aceita meta_instagram com ig_account_id e ig_username", async () => {
    const { rowCount } = await pool.query(
      `insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted, ig_account_id, ig_username)
       values ($1, 'meta_instagram', 'WORKING', decode('00','hex'), '17841400000000001', 'clinica')`,
      [ORG_A],
    );
    expect(rowCount).toBe(1);
  });
});

describe("conversations aceita channel instagram", () => {
  it("a definição da constraint cita instagram", async () => {
    const { rows } = await pool.query<{ ok: boolean }>(
      `select pg_get_constraintdef(oid) ~ 'instagram' as ok
         from pg_constraint where conname = 'conversations_channel_check'`,
    );
    expect(rows[0]?.ok).toBe(true);
  });
});

describe("fn_upsert_contato_por_identidade", () => {
  it("é idempotente e isola organizações", async () => {
    const { rows: a1 } = await pool.query(
      `select * from fn_upsert_contato_por_identidade($1, 'instagram', 'IGSID1', 'maria', 'Maria', null)`,
      [ORG_A],
    );
    const { rows: a2 } = await pool.query(
      `select * from fn_upsert_contato_por_identidade($1, 'instagram', 'IGSID1', 'maria', 'Maria', null)`,
      [ORG_A],
    );
    const { rows: b1 } = await pool.query(
      `select * from fn_upsert_contato_por_identidade($1, 'instagram', 'IGSID1', 'maria', 'Maria', null)`,
      [ORG_B],
    );
    expect(a1[0]?.criado).toBe(true);
    expect(a2[0]?.criado).toBe(false);
    expect(a2[0]?.contact_id).toBe(a1[0]?.contact_id);
    expect(b1[0]?.contact_id).not.toBe(a1[0]?.contact_id);
  });
});

describe("privilégio das RPCs novas", () => {
  it("não são alcançáveis por anon nem authenticated", async () => {
    const { rows } = await pool.query<{ proname: string; anon: boolean; auth: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('fn_upsert_contato_por_identidade', 'fn_upsert_conversa_de_canal')`,
    );
    expect(rows).toHaveLength(2);
    for (const l of rows) {
      expect([l.anon, l.auth]).toEqual([false, false]);
    }
  });
});

describe("RLS de contact_channel_identities", () => {
  it("tem RLS ligada com a policy tenant_isolation_contact_channel_identities_all", async () => {
    const { rows: rls } = await pool.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where relname = 'contact_channel_identities'`,
    );
    expect(rls[0]?.rls).toBe(true);

    const { rows: pol } = await pool.query<{ n: string }>(
      `select count(*)::int as n from pg_policies
        where tablename = 'contact_channel_identities'
          and policyname = 'tenant_isolation_contact_channel_identities_all'`,
    );
    expect(Number(pol[0]?.n)).toBe(1);
  });

  it("membro autenticado da org A NÃO lê identidade de canal da org B (cross-org real)", async () => {
    const userA = "1657a000-1111-4000-8000-000000000001";
    const userB = "1657a000-1111-4000-8000-000000000002";
    await pool.query(
      `insert into auth.users (id, email) values ($1, 'instagram-canal-a@invariant.test')
         on conflict (id) do nothing`,
      [userA],
    );
    await pool.query(
      `insert into auth.users (id, email) values ($1, 'instagram-canal-b@invariant.test')
         on conflict (id) do nothing`,
      [userB],
    );
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
         values ($1, $2, 'agent', now())
       on conflict do nothing`,
      [userA, ORG_A],
    );
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
         values ($1, $2, 'agent', now())
       on conflict do nothing`,
      [userB, ORG_B],
    );

    const { rows: contatoA } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Contato Instagram A') returning id`,
      [ORG_A],
    );
    const { rows: contatoB } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Contato Instagram B') returning id`,
      [ORG_B],
    );
    await pool.query(
      `insert into contact_channel_identities (organization_id, contact_id, channel, external_id, handle)
         values ($1, $2, 'instagram', 'IGSID-A', 'contato_a')`,
      [ORG_A, contatoA[0]!.id],
    );
    await pool.query(
      `insert into contact_channel_identities (organization_id, contact_id, channel, external_id, handle)
         values ($1, $2, 'instagram', 'IGSID-B', 'contato_b')`,
      [ORG_B, contatoB[0]!.id],
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userA }),
      ]);
      // Filtra por external_id desta prova, não pela org inteira: o describe
      // anterior ("fn_upsert_contato_por_identidade") já deixou IGSID1 em ORG_A
      // — contar a org toda acoplaria este teste à ordem dos describes vizinhos.
      const { rows: propria } = await client.query<{ n: string }>(
        "select count(*)::int as n from contact_channel_identities where organization_id = $1 and external_id = 'IGSID-A'",
        [ORG_A],
      );
      const { rows: alheia } = await client.query<{ n: string }>(
        "select count(*)::int as n from contact_channel_identities where organization_id = $1 and external_id = 'IGSID-B'",
        [ORG_B],
      );
      expect(Number(propria[0]?.n)).toBe(1);
      expect(Number(alheia[0]?.n)).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
