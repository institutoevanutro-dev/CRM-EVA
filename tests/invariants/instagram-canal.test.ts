import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("tem RLS ligada e UMA policy PERMISSIVA, só de SELECT (migration 0279): a equipe lê, não grava", async () => {
    const { rows: rls } = await pool.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where relname = 'contact_channel_identities'`,
    );
    expect(rls[0]?.rls).toBe(true);

    const { rows: pol } = await pool.query<{ policyname: string; cmd: string }>(
      // Só as permissivas: as `support_write_*` são RESTRITIVAS (só cortam, nunca
      // concedem) e toda tabela de tenant as ganha pelo laço do modo suporte.
      `select policyname, cmd from pg_policies
        where tablename = 'contact_channel_identities' and permissive = 'PERMISSIVE' order by policyname`,
    );
    expect(pol).toEqual([{ policyname: "tenant_isolation_contact_channel_identities_select", cmd: "SELECT" }]);
  });

  it("agent autenticado lê a identidade da própria org mas não insere, não troca o handle e não apaga; service role sim", async () => {
    const agente = "1657a000-1111-4000-8000-000000000279";
    await pool.query(
      `insert into auth.users (id, email) values ($1, 'instagram-canal-279@invariant.test') on conflict (id) do nothing`,
      [agente],
    );
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
         values ($1, $2, 'agent', now()) on conflict do nothing`,
      [agente, ORG_A],
    );
    const { rows: contato } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Contato 0279') returning id`,
      [ORG_A],
    );
    await pool.query(
      `insert into contact_channel_identities (organization_id, contact_id, channel, external_id, handle)
         values ($1, $2, 'instagram', 'IGSID-0279', 'original_0279')`,
      [ORG_A, contato[0]!.id],
    );

    const comoAgente = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: agente })]);
        return await fn(client);
      } finally {
        await client.query("rollback");
        client.release();
      }
    };

    // Controle positivo: a leitura funciona (a RLS não está só negando tudo).
    const lidas = await comoAgente((c) =>
      c.query("select handle from contact_channel_identities where external_id = 'IGSID-0279'"),
    );
    expect(lidas.rows).toEqual([{ handle: "original_0279" }]);

    await expect(
      comoAgente((c) =>
        c.query(
          `insert into contact_channel_identities (organization_id, contact_id, channel, external_id, handle)
             values ($1, $2, 'instagram', 'IGSID-0279-FORJADO', 'original_0279')`,
          [ORG_A, contato[0]!.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    const trocou = await comoAgente((c) =>
      c.query("update contact_channel_identities set handle = 'forjado' where external_id = 'IGSID-0279'"),
    );
    expect(trocou.rowCount).toBe(0);
    const apagou = await comoAgente((c) => c.query("delete from contact_channel_identities where external_id = 'IGSID-0279'"));
    expect(apagou.rowCount).toBe(0);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role service_role");
      const r = await client.query("update contact_channel_identities set handle = 'vivo_0279' where external_id = 'IGSID-0279'");
      expect(r.rowCount).toBe(1);
      await client.query("rollback");
    } finally {
      client.release();
    }
    const { rows: final } = await pool.query("select handle from contact_channel_identities where external_id = 'IGSID-0279'");
    expect(final).toEqual([{ handle: "original_0279" }]);
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

describe("conversa do Instagram cai na Fila, não no Automático (migration 0278)", () => {
  // O bloco LIDO do baseline pelo rótulo: é o texto que o install/update do
  // self-host aplica, não uma cópia digitada aqui.
  const ROTULO = "-- ---- destinatário das conversas do Instagram (migration 0278) ----";
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(ROTULO);
  const bloco = baseline.slice(inicio, baseline.indexOf("\n-- ---- ", inicio + ROTULO.length));

  it("o backfill cala a IA para sempre no Instagram, é idempotente e não toca o WhatsApp", async () => {
    expect(inicio, "rótulo da 0278 sumiu do baseline").toBeGreaterThan(-1);
    const { rows: ct } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Fila Instagram') returning id`,
      [ORG_A],
    );
    const { rows: ct2 } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Fila WhatsApp') returning id`,
      [ORG_A],
    );
    const { rows: sessao } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted, ig_account_id, ig_username)
         values ($1, 'meta_instagram', 'WORKING', decode('00','hex'), '17841400000000278', 'fila') returning id`,
      [ORG_A],
    );
    const { rows: ig } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, channel, status)
         values ($1, $2, $3, 'instagram', 'open') returning id`,
      [ORG_A, ct[0]!.id, sessao[0]!.id],
    );
    const { rows: wa } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, status)
         values ($1, $2, $3, 'open') returning id`,
      [ORG_A, ct2[0]!.id, sessao[0]!.id],
    );
    const comando = async (id: string) =>
      (await pool.query<{ q: string }>("select comando_da_conversa(c) as q from conversations c where id = $1", [id]))
        .rows[0]?.q;

    // Controle negativo: antes do backfill, a regra real a manda para o Automático.
    expect(await comando(ig[0]!.id)).toBe("automatico");

    await pool.query(bloco);
    await pool.query(bloco);

    expect(await comando(ig[0]!.id)).toBe("aguardando");
    expect(await comando(wa[0]!.id)).toBe("automatico");
    const { rows } = await pool.query<{ inf: boolean }>(
      "select bot_silenced_until = 'infinity'::timestamptz as inf from conversations where id = $1",
      [ig[0]!.id],
    );
    expect(rows[0]?.inf).toBe(true);
  });
});

describe("mesmo @ vira um contato só (fn_mesclar_contatos, dois IGSIDs de um perfil só)", () => {
  it("o secundário fica is_merged_into = principal e as DUAS conversas (sessões diferentes) apontam pro principal", async () => {
    const { rows: principal } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name, created_at) values ($1, 'Maria Perfil 1', now() - interval '2 days') returning id`,
      [ORG_A],
    );
    const { rows: secundario } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name, created_at) values ($1, 'Maria Perfil 2', now()) returning id`,
      [ORG_A],
    );
    // Mesmo @, maiúsculas diferentes — a comparação de `juntarPorArroba` é
    // case-insensitive (`.ilike`); aqui só interessa o RESULTADO do merge.
    await pool.query(
      `insert into contact_channel_identities (organization_id, contact_id, channel, external_id, handle)
         values ($1, $2, 'instagram', 'IGSID-MARIA-1', 'Maria.Silva')`,
      [ORG_A, principal[0]!.id],
    );
    await pool.query(
      `insert into contact_channel_identities (organization_id, contact_id, channel, external_id, handle)
         values ($1, $2, 'instagram', 'IGSID-MARIA-2', 'maria.silva')`,
      [ORG_A, secundario[0]!.id],
    );
    const { rows: sessaoA } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted, ig_account_id, ig_username)
         values ($1, 'meta_instagram', 'WORKING', decode('00','hex'), '17841400000000301', 'perfil_a') returning id`,
      [ORG_A],
    );
    const { rows: sessaoB } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, provider, status, webhook_secret_encrypted, ig_account_id, ig_username)
         values ($1, 'meta_instagram', 'WORKING', decode('00','hex'), '17841400000000302', 'perfil_b') returning id`,
      [ORG_A],
    );
    const { rows: conversaPrincipal } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, channel, status)
         values ($1, $2, $3, 'instagram', 'open') returning id`,
      [ORG_A, principal[0]!.id, sessaoA[0]!.id],
    );
    const { rows: conversaSecundaria } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, channel, status)
         values ($1, $2, $3, 'instagram', 'open') returning id`,
      [ORG_A, secundario[0]!.id, sessaoB[0]!.id],
    );

    // Chamada exatamente como `juntarPorArroba` chama: sem `set local role`
    // (equivalente ao service role — `auth.uid()` nulo pula a checagem de
    // papel, que é quem resolve `organization_id` de fonte confiável).
    const { rows: resultado } = await pool.query<{ contato_id: string }>(
      `select (fn_mesclar_contatos($1, $2, $3)->>'contato_id') as contato_id`,
      [ORG_A, principal[0]!.id, [secundario[0]!.id]],
    );
    expect(resultado[0]?.contato_id).toBe(principal[0]!.id);

    const { rows: lapide } = await pool.query<{ is_merged_into: string }>(
      "select is_merged_into from contacts where id = $1",
      [secundario[0]!.id],
    );
    expect(lapide[0]?.is_merged_into).toBe(principal[0]!.id);

    // Prova o motivo do teste: as duas conversas (sessões DIFERENTES) agora
    // apontam para o MESMO contato sem colidir com
    // `uniq_conversations_1to1_per_contact_session` (que é por contato+sessão,
    // não só por contato).
    const { rows: conversas } = await pool.query<{ id: string; contact_id: string }>(
      "select id, contact_id from conversations where id = any($1)",
      [[conversaPrincipal[0]!.id, conversaSecundaria[0]!.id]],
    );
    expect(conversas.every((c) => c.contact_id === principal[0]!.id)).toBe(true);
  });
});
