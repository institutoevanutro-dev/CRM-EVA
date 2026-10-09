/**
 * OS AVISOS DE PEDIDO DO CLIENTE (migration 0349), CONTRA O POSTGRES REAL.
 *
 * Porte da 0500 de melgarafael/DeskcommCRM. Prova: os dois kinds entram; um
 * aviso por conversa e pedido (índice único); os gatilhos fecham o aviso
 * quando o pedido foi atendido, sem tocar outra organização; as funções de
 * gatilho não são chamáveis por anon nem authenticated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const A = { org: "0349a000-0000-4000-8000-000000000001", contato: "0349a000-0000-4000-8000-0000000000c1", sessao: "0349a000-0000-4000-8000-0000000000a1", conversa: "0349a000-0000-4000-8000-0000000000f1" };
const B = { org: "0349b000-0000-4000-8000-000000000002", contato: "0349b000-0000-4000-8000-0000000000c2", sessao: "0349b000-0000-4000-8000-0000000000a2", conversa: "0349b000-0000-4000-8000-0000000000f2" };

async function semear(t: typeof A, slug: string) {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Org Teste','Org Teste')`,
    [t.org, slug],
  );
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Cliente Fictícia',$3)`, [
    t.contato,
    t.org,
    `+55119000${slug.length}0349`,
  ]);
  await pool.query(
    `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
     values($1,$2,'waha',$3,'WORKING','\\x00'::bytea)`,
    [t.sessao, t.org, `s-${slug}`],
  );
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group)
     values($1,$2,$3,$4,'ai_handling',false)`,
    [t.conversa, t.org, t.contato, t.sessao],
  );
}

async function aviso(t: typeof A, kind: string) {
  await pool.query(
    `insert into agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
     values($1,$2,'warn','t','b','conversation',$3)`,
    [t.org, kind, t.conversa],
  );
}

async function estados(t: typeof A) {
  const { rows } = await pool.query<{ kind: string; status: string }>(
    `select kind, status from agent_inbox_items where organization_id=$1 and ref_id=$2 order by kind`,
    [t.org, t.conversa],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r.status]));
}

async function zerar() {
  await pool.query(`delete from agent_inbox_items where organization_id = any($1::uuid[])`, [[A.org, B.org]]);
  await pool.query(
    `update conversations set status='ai_handling', assigned_to_user_id=null, bot_silenced_until=null, last_handoff_at=null
      where organization_id = any($1::uuid[])`,
    [[A.org, B.org]],
  );
  await pool.query(`update contacts set is_blocked=false where organization_id = any($1::uuid[])`, [[A.org, B.org]]);
}

beforeAll(async () => {
  await semear(A, "org-0349-a");
  await semear(B, "org-0349-b");
});

afterAll(async () => {
  await zerar();
  for (const t of [A, B]) {
    await pool.query(`delete from conversations where organization_id=$1`, [t.org]);
    await pool.query(`delete from channel_sessions where organization_id=$1`, [t.org]);
    await pool.query(`delete from contacts where organization_id=$1`, [t.org]);
    await pool.query(`delete from organizations where id=$1`, [t.org]);
  }
  await pool.end();
});

describe("avisos de pedido do cliente (0349)", () => {
  it("os dois kinds entram, e um aviso por conversa e pedido", async () => {
    await zerar();
    await aviso(A, "jev_pedido_de_humano");
    await aviso(A, "jev_parar_de_receber");
    await expect(aviso(A, "jev_parar_de_receber")).rejects.toMatchObject({ code: "23505" });
    // outra organização, mesma forma: não colide
    await aviso(B, "jev_parar_de_receber");
    expect(await estados(A)).toEqual({ jev_parar_de_receber: "open", jev_pedido_de_humano: "open" });
  });

  it("passar a conversa fecha só o de pessoa, e só nesta organização", async () => {
    await zerar();
    for (const t of [A, B]) {
      await aviso(t, "jev_pedido_de_humano");
      await aviso(t, "jev_parar_de_receber");
    }
    await pool.query(`update conversations set last_handoff_at=now(), bot_silenced_until='infinity' where id=$1`, [A.conversa]);
    expect(await estados(A)).toEqual({ jev_parar_de_receber: "open", jev_pedido_de_humano: "resolved" });
    expect(await estados(B)).toEqual({ jev_parar_de_receber: "open", jev_pedido_de_humano: "open" });
  });

  it("encerrar a conversa fecha os dois", async () => {
    await zerar();
    await aviso(A, "jev_pedido_de_humano");
    await aviso(A, "jev_parar_de_receber");
    await pool.query(`update conversations set status='closed' where id=$1`, [A.conversa]);
    expect(await estados(A)).toEqual({ jev_parar_de_receber: "resolved", jev_pedido_de_humano: "resolved" });
  });

  it("bloquear o contato fecha o de parar de receber, e só o dele", async () => {
    await zerar();
    await aviso(A, "jev_parar_de_receber");
    await aviso(B, "jev_parar_de_receber");
    await pool.query(`update contacts set is_blocked=true where id=$1`, [A.contato]);
    expect(await estados(A)).toEqual({ jev_parar_de_receber: "resolved" });
    expect(await estados(B)).toEqual({ jev_parar_de_receber: "open" });
  });

  it("as funções de gatilho não são chamáveis por anon nem authenticated", async () => {
    const { rows } = await pool.query<{ fn: string; anon: boolean; auth: boolean }>(
      `select p.proname as fn,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname in ('fn_fechar_avisos_do_jev_da_conversa','fn_fechar_aviso_do_jev_ao_bloquear')
        order by 1`,
    );
    expect(rows).toEqual([
      { fn: "fn_fechar_aviso_do_jev_ao_bloquear", anon: false, auth: false },
      { fn: "fn_fechar_avisos_do_jev_da_conversa", anon: false, auth: false },
    ]);
  });
});
