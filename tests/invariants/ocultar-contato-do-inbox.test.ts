import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { decidirElegibilidadeDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";
import { sql } from "./gov-helpers";

/**
 * OCULTAR UM CONTATO DO INBOX (migration 0372).
 *
 *   O1  conversa nova HERDA a marca do contato
 *   O2  ocultar e trazer de volta chega a TODAS as conversas do contato
 *   O3  trocar o contato da conversa (junção) recalcula a marca
 *   O4  só o servidor marca: a sessão recebe 42501 ao escrever a marca, e continua
 *       editando o resto da ficha
 *   O5  isolamento: ocultar na organização A não toca a B
 *   O6  o painel de conversas por dia do Início não conta a conversa oculta
 *   O7  `authenticated` lê a marca (grant de coluna), e as funções de gatilho não
 *       são alcançáveis pela REST
 *   O8  o contato oculto não ganha card no funil (`garantirLeadDaConversa`, a
 *       função de verdade, sobre o schema real); o visível ganha
 *   O9  o gate da IA, pela consulta `pg` do motor, cala a conversa oculta
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});

const A = "0c372000-0000-4000-8000-00000000000a";
const B = "0c372000-0000-4000-8000-00000000000b";
const CANAL_A = "0c372000-0000-4000-8000-0000000000ca";
// Uma conversa por contato e por canal (`uniq_conversations_1to1_per_contact_session`):
// cada conversa a mais do mesmo contato precisa de outro canal.
const CANAL_A2 = "0c372000-0000-4000-8000-0000000000c2";
const CANAL_A3 = "0c372000-0000-4000-8000-0000000000c3";
const CANAL_B = "0c372000-0000-4000-8000-0000000000cb";
const GESTOR = "0c372000-1111-4000-8000-000000000001"; // manager de A
const AMIGO = "0c372000-3333-4000-8000-000000000001"; // contato de A que vai ser ocultado
const PACIENTE = "0c372000-3333-4000-8000-000000000002"; // contato de A que fica visível
const DA_B = "0c372000-3333-4000-8000-000000000003"; // contato da B
const OUTRO_OCULTO = "0c372000-3333-4000-8000-000000000004"; // de A, oculto, sem conversa no CANAL_A

async function comoGestor<T>(fn: (q: (t: string, v?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GESTOR, aal: "aal1", role: "authenticated" }),
    ]);
    await fn(async (t, v) => (await c.query(t, v as unknown[])) as unknown as { rows: T[]; rowCount: number | null });
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const marcas = async (contato: string) =>
  (
    await pool.query<{ oculto: boolean }>(
      "select contato_oculto as oculto from public.conversations where contact_id = $1 order by created_at",
      [contato],
    )
  ).rows.map((r) => r.oculto);

const ocultar = (contato: string) =>
  pool.query("update public.contacts set inbox_hidden_at = now(), inbox_hidden_by = $2 where id = $1", [contato, GESTOR]);
const mostrar = (contato: string) =>
  pool.query("update public.contacts set inbox_hidden_at = null, inbox_hidden_by = null where id = $1", [contato]);

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values ('${GESTOR}','c0372-1@invariant.test');
    insert into public.organizations(id,slug,display_name,legal_name) values ('${A}','c0372-a','A','A'),('${B}','c0372-b','B','B');
    insert into public.user_organizations(organization_id,user_id,role,accepted_at) values ('${A}','${GESTOR}','manager',now());
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values
      ('${CANAL_A}','${A}','c0372-a','\\x00'::bytea), ('${CANAL_A2}','${A}','c0372-a2','\\x00'::bytea),
      ('${CANAL_A3}','${A}','c0372-a3','\\x00'::bytea), ('${CANAL_B}','${B}','c0372-b','\\x00'::bytea);
    insert into public.contacts(id,organization_id,display_name) values
      ('${AMIGO}','${A}','Amigo do perfil pessoal'), ('${PACIENTE}','${A}','Paciente Exemplo'),
      ('${DA_B}','${B}','Contato da B'), ('${OUTRO_OCULTO}','${A}','Outro amigo');
    insert into public.conversations(organization_id,contact_id,channel_session_id,status) values
      ('${A}','${AMIGO}','${CANAL_A}','open'), ('${A}','${AMIGO}','${CANAL_A2}','closed'),
      ('${A}','${PACIENTE}','${CANAL_A}','open'), ('${B}','${DA_B}','${CANAL_B}','open');
  `);
});
afterAll(async () => {
  await pool.query("delete from public.crm_leads where organization_id = any($1)", [[A, B]]);
  await pool.query("delete from public.organizations where id = any($1)", [[A, B]]);
  await pool.end();
});

describe("0372 — ocultar um contato do Inbox", () => {
  it("O2 · ocultar chega a todas as conversas do contato, e trazer de volta também", async () => {
    expect(await marcas(AMIGO)).toEqual([false, false]);
    await ocultar(AMIGO);
    expect(await marcas(AMIGO)).toEqual([true, true]);
    expect(await marcas(PACIENTE)).toEqual([false]);
    await mostrar(AMIGO);
    expect(await marcas(AMIGO)).toEqual([false, false]);
    await ocultar(AMIGO);
  });

  it("O1 · conversa nova de contato oculto já nasce oculta", async () => {
    const { rows } = await pool.query<{ oculto: boolean }>(
      `insert into public.conversations(organization_id,contact_id,channel_session_id,status)
         values ($1,$2,$3,'open') returning contato_oculto as oculto`,
      [A, AMIGO, CANAL_A3],
    );
    expect(rows[0]!.oculto).toBe(true);
  });

  it("O3 · trocar o contato da conversa recalcula a marca", async () => {
    await ocultar(OUTRO_OCULTO);
    const { rows } = await pool.query<{ id: string }>(
      "select id from public.conversations where contact_id = $1 limit 1",
      [PACIENTE],
    );
    const id = rows[0]!.id;
    const paraOAmigo = await pool.query<{ oculto: boolean }>(
      "update public.conversations set contact_id = $1 where id = $2 returning contato_oculto as oculto",
      [OUTRO_OCULTO, id],
    );
    expect(paraOAmigo.rows[0]!.oculto).toBe(true);
    const deVolta = await pool.query<{ oculto: boolean }>(
      "update public.conversations set contact_id = $1 where id = $2 returning contato_oculto as oculto",
      [PACIENTE, id],
    );
    expect(deVolta.rows[0]!.oculto).toBe(false);
  });

  it("O4 · a sessão não escreve a marca (42501), mas segue editando a ficha", async () => {
    await comoGestor(async (q) => {
      const r = await q("update public.contacts set display_name = 'Paciente Renomeado' where id = $1", [PACIENTE]);
      expect(r.rowCount).toBe(1);
    });
    for (const tentativa of [
      "update public.contacts set inbox_hidden_at = null where id = $1",
      "update public.contacts set inbox_hidden_by = null where id = $1",
    ]) {
      await expect(comoGestor((q) => q(tentativa, [AMIGO]).then(() => undefined))).rejects.toMatchObject({
        code: "42501",
        message: expect.stringContaining("ocultacao_do_contato_so_o_servidor"),
      });
    }
    await expect(
      comoGestor((q) => q("update public.contacts set inbox_hidden_at = now() where id = $1", [PACIENTE]).then(() => undefined)),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      comoGestor((q) =>
        q(
          "insert into public.contacts(organization_id,display_name,inbox_hidden_at) values ($1,'nasce oculto',now())",
          [A],
        ).then(() => undefined),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // A marca segue como o servidor deixou.
    expect(await marcas(AMIGO)).not.toContain(false);
  });

  it("O5 · ocultar na organização A não toca a B", async () => {
    expect(await marcas(DA_B)).toEqual([false]);
  });

  it("O6 · o painel de conversas por dia do Início não conta a conversa oculta", async () => {
    const { rows } = await pool.query<{ total: number }>(
      `select coalesce(sum(ia_sozinha + com_equipe + sem_resposta), 0)::int as total
         from public.fn_inicio_conversas_por_dia($1, now() - interval '1 day', now() + interval '1 day', 'America/Sao_Paulo')`,
      [A],
    );
    // Na A: a do paciente conta; as do amigo (ocultas), não.
    expect(rows[0]!.total).toBe(1);
  });

  it("O8 · contato oculto não ganha card no funil; o visível ganha", async () => {
    const db = pgComoSupabase(pool);
    const conversaDe = async (contato: string) =>
      (await pool.query<{ id: string }>("select id from public.conversations where contact_id = $1 limit 1", [contato])).rows[0]!.id;
    const oculto = await garantirLeadDaConversa(db, {
      organizationId: A,
      contactId: AMIGO,
      conversationId: await conversaDe(AMIGO),
      nomeDoContato: "Amigo",
    });
    expect(oculto).toEqual({ criado: false, motivo: "contato_oculto" });
    const visivel = await garantirLeadDaConversa(db, {
      organizationId: A,
      contactId: PACIENTE,
      conversationId: await conversaDe(PACIENTE),
      nomeDoContato: "Paciente",
    });
    expect(visivel.criado, JSON.stringify(visivel)).toBe(true);
    const { rows } = await pool.query("select count(*)::int n from public.crm_leads where contact_id = $1", [AMIGO]);
    expect(rows[0].n).toBe(0);
  });

  it("O9 · o gate da IA (consulta do motor) cala a conversa do contato oculto", async () => {
    const conversaDe = async (contato: string) =>
      (await pool.query<{ id: string }>("select id from public.conversations where contact_id = $1 limit 1", [contato])).rows[0]!.id;
    const agora = new Date();
    const oculta = await decidirElegibilidadeDaConversa(pool, {
      organizationId: A,
      conversationId: await conversaDe(AMIGO),
      agora,
      ttlMs: 86_400_000,
    });
    expect(oculta).toEqual({ permite: false, motivo: "contato_oculto", bloqueioPorAllowlist: false });
    const visivel = await decidirElegibilidadeDaConversa(pool, {
      organizationId: A,
      conversationId: await conversaDe(PACIENTE),
      agora,
      ttlMs: 86_400_000,
    });
    expect(visivel?.motivo).not.toBe("contato_oculto");
  });

  it("O7 · authenticated lê a marca; as funções de gatilho não são alcançáveis pela REST", async () => {
    await comoGestor<{ oculto: string | null }>(async (q) => {
      const { rows } = await q("select inbox_hidden_at::text as oculto from public.contacts where id = $1", [AMIGO]);
      expect(rows[0]!.oculto).not.toBeNull();
    });
    const { rows } = await pool.query(
      `select p.proname, has_function_privilege('authenticated', p.oid, 'execute') a, has_function_privilege('anon', p.oid, 'execute') n
         from pg_proc p
        where p.proname in ('fn_conversa_herda_ocultacao_do_contato','fn_contato_propaga_ocultacao','fn_ocultacao_do_contato_so_o_servidor')
        order by 1`,
    );
    expect(rows).toEqual([
      { proname: "fn_contato_propaga_ocultacao", a: false, n: false },
      { proname: "fn_conversa_herda_ocultacao_do_contato", a: false, n: false },
      { proname: "fn_ocultacao_do_contato_so_o_servidor", a: false, n: false },
    ]);
  });
});
