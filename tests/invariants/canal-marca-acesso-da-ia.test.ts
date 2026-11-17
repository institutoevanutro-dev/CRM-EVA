import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 0418: `channel_sessions.ai_access_since` avança quando o alcance da
 * IA no canal muda, por qualquer caminho, e só então. É o piso por canal da
 * varredura de silêncio (lib/followup/silence-sweep.ts) — incidente de
 * 17/11/2026, em que abrir o canal inscreveu 80 conversas paradas desde 02/11.
 */
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
const org = randomUUID(), canal = randomUUID();
const marca = async (): Promise<Date | null> =>
  (await pool.query("select ai_access_since from channel_sessions where id=$1", [canal])).rows[0].ai_access_since;

beforeAll(async () => {
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [org]);
  await pool.query(
    `insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,metadata)
     values($1::uuid,$2,$1::text,'\\x00','{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}')`,
    [canal, org],
  );
});
afterAll(async () => { await pool.end(); });

describe("marca do acesso da IA no canal (0418)", () => {
  it("canal recém-criado nasce sem marca", async () => {
    expect(await marca()).toBeNull();
  });

  it("abrir o canal pela RPC da tela grava a marca", async () => {
    await pool.query("select fn_configurar_pre_go_live_canal($1,$2,'open',$3)", [org, canal, []]);
    expect(await marca()).not.toBeNull();
  });

  it("mexer em outra chave da metadata, ou regravar o mesmo alcance, não avança a marca", async () => {
    await pool.query("update channel_sessions set ai_access_since = '2026-01-01T00:00:00Z' where id=$1", [canal]);
    await pool.query(`update channel_sessions set metadata = metadata || '{"transport":{"x":1}}' where id=$1`, [canal]);
    await pool.query("select fn_configurar_pre_go_live_canal($1,$2,'open',$3)", [org, canal, []]);
    expect((await marca())?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("mudar a lista de testadores por UPDATE direto também avança", async () => {
    await pool.query(
      `update channel_sessions set metadata = jsonb_set(metadata, '{ai_test_phone_numbers}', '["+5511987654321"]') where id=$1`,
      [canal],
    );
    expect((await marca())!.getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("a função do trigger não é executável por anon nem por membros", async () => {
    const { rows } = await pool.query(`select
      has_function_privilege('anon','fn_canal_marca_acesso_da_ia()','execute') as anon,
      has_function_privilege('authenticated','fn_canal_marca_acesso_da_ia()','execute') as membro`);
    expect(rows[0]).toEqual({ anon: false, membro: false });
  });
});
