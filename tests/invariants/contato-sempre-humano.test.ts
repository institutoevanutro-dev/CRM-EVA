/**
 * CONTATO "SEMPRE ATENDIMENTO HUMANO" (migration 0366).
 *
 * `contacts.ai_opt_out` é a marca permanente: a IA nunca atende o contato. O banco
 * garante a regra de que todo o resto depende: com a marca ligada, `force_human`
 * fica ligado. Toda guarda da IA já lê `force_human` (turno de entrada, roteador,
 * follow-up, envio da agenda pela IA, before-send), e a conversa espelha a trava
 * em `contato_segura_robo`. Medido aqui no banco real, porque um dublê não prova
 * gatilho.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`, max: 2 });
afterAll(() => pool.end());

const CONTATO = "cccccccc-3333-4000-8000-0000000003a1";
const CONVERSA = "cccccccc-4444-4000-8000-0000000003a1";
const NASCE_MARCADO = "cccccccc-3333-4000-8000-0000000003a2";

const trava = async (id: string) =>
  (
    await pool.query<{ ai_opt_out: boolean; force_human: boolean }>(
      "select ai_opt_out, force_human from public.contacts where id = $1",
      [id],
    )
  ).rows[0];

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Contato sempre humano') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'ai_handling') on conflict do nothing;
  `);
});

describe("a marca 'sempre atendimento humano' segura force_human", () => {
  it("nasce desligada e não muda nada sozinha", async () => {
    expect(await trava(CONTATO)).toEqual({ ai_opt_out: false, force_human: false });
  });

  it("marcar liga force_human e a conversa passa a segurar o robô", async () => {
    await pool.query("update public.contacts set ai_opt_out = true, force_human = true where id = $1", [CONTATO]);
    expect(await trava(CONTATO)).toEqual({ ai_opt_out: true, force_human: true });
    const { rows } = await pool.query<{ s: boolean }>(
      "select contato_segura_robo as s from public.conversations where id = $1",
      [CONVERSA],
    );
    expect(rows[0]?.s).toBe(true);
  });

  it("⚠️ soltar force_human por baixo da marca não solta (a devolução não desfaz)", async () => {
    await pool.query("update public.contacts set force_human = false where id = $1", [CONTATO]);
    expect(await trava(CONTATO)).toEqual({ ai_opt_out: true, force_human: true });
  });

  it("marcar sem mandar force_human também liga a trava", async () => {
    await pool.query("update public.contacts set ai_opt_out = false where id = $1", [CONTATO]);
    await pool.query("update public.contacts set force_human = false where id = $1", [CONTATO]);
    await pool.query("update public.contacts set ai_opt_out = true where id = $1", [CONTATO]);
    expect(await trava(CONTATO)).toEqual({ ai_opt_out: true, force_human: true });
  });

  it("contato que já nasce marcado nasce com a trava", async () => {
    await pool.query(
      "insert into public.contacts (id, organization_id, display_name, ai_opt_out, force_human) values ($1, $2, 'Nasce marcado', true, false) on conflict do nothing",
      [NASCE_MARCADO, GOV_ORG],
    );
    expect(await trava(NASCE_MARCADO)).toEqual({ ai_opt_out: true, force_human: true });
  });

  it("desmarcar NÃO devolve o atendimento; depois disso, a devolução volta a soltar", async () => {
    await pool.query("update public.contacts set ai_opt_out = false where id = $1", [CONTATO]);
    expect(await trava(CONTATO)).toEqual({ ai_opt_out: false, force_human: true });
    await pool.query("update public.contacts set force_human = false where id = $1", [CONTATO]);
    expect(await trava(CONTATO)).toEqual({ ai_opt_out: false, force_human: false });
  });

  it("a ficha do contato lê a marca (grant por coluna da 0289)", async () => {
    const { rows } = await pool.query<{ ok: boolean }>(
      "select has_column_privilege('authenticated', 'public.contacts', 'ai_opt_out', 'select') as ok",
    );
    expect(rows[0]?.ok).toBe(true);
  });

  it("a função do gatilho não é alcançável pela REST", async () => {
    const { rows } = await pool.query<{ anon: boolean; auth: boolean }>(
      `select has_function_privilege('anon', 'public.fn_contacts_ai_opt_out_segura_humano()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_contacts_ai_opt_out_segura_humano()', 'execute') as auth`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false });
  });
});
