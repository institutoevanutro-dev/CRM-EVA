/**
 * O AVISO DE AGENDAMENTO (migration 0391), CONTRA O POSTGRES REAL.
 *
 * Prova: as colunas novas existem e os segredos do Google são bytea; as duas
 * tabelas seguem fora do alcance de anon e authenticated (nem a própria
 * organização lê pelo client de sessão); um envio por (agendamento, plataforma)
 * no banco; a linha precisa de um alvo; apagar o compromisso leva a linha junto;
 * o kind novo da Central entra, com um aberto por organização; e reaplicar o
 * bloco do baseline não desliga de novo uma conexão que alguém ligou.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const A = {
  org: "0391a000-0000-4000-8000-000000000001",
  contato: "0391a000-0000-4000-8000-0000000000c1",
  compromisso: "0391a000-0000-4000-8000-0000000000e1",
  usuario: "0391a000-0000-4000-8000-0000000000b1",
};
const B = {
  org: "0391b000-0000-4000-8000-000000000002",
  contato: "0391b000-0000-4000-8000-0000000000c2",
  compromisso: "0391b000-0000-4000-8000-0000000000e2",
  usuario: "0391b000-0000-4000-8000-0000000000b2",
};

async function semear(t: typeof A, slug: string, n: number) {
  await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Org Teste','Org Teste')`, [
    t.org,
    slug,
  ]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Paciente Fictícia',$3)`, [
    t.contato,
    t.org,
    `+5511900000${n}391`,
  ]);
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,time_zone,status)
     values($1,$2,$3,'Consulta','2030-07-03T20:30:00Z','2030-07-03T21:00:00Z','America/Sao_Paulo','confirmed')`,
    [t.compromisso, t.org, t.contato],
  );
  await pool.query(
    `insert into auth.users(id, email) values($1, $2) on conflict (id) do nothing`,
    [t.usuario, `${slug}@example.com`],
  );
  await pool.query(`insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())`, [
    t.org,
    t.usuario,
  ]);
}

async function envio(t: typeof A, plataforma = "meta_ads", compromisso: string | null = t.compromisso) {
  await pool.query(
    `insert into ad_conversion_dispatches(organization_id,appointment_id,platform,event_name,status)
     values($1,$2,$3,'Schedule','sent')`,
    [t.org, compromisso, plataforma],
  );
}

async function codigoDoErro(f: () => Promise<unknown>): Promise<string | null> {
  try {
    await f();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "sem_codigo";
  }
}

/** Lê como o usuário logado da organização A, pelo papel que o PostgREST assume. */
async function comoMembroDeA(consulta: string): Promise<string | null> {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: A.usuario, role: "authenticated" }),
    ]);
    await cliente.query("set local role authenticated");
    return await codigoDoErro(() => cliente.query(consulta));
  } finally {
    await cliente.query("rollback");
    cliente.release();
  }
}

beforeAll(async () => {
  await semear(A, "org-0391-a", 1);
  await semear(B, "org-0391-b", 2);
});

afterAll(async () => {
  for (const t of [A, B]) {
    await pool.query(`delete from agent_inbox_items where organization_id=$1`, [t.org]);
    await pool.query(`delete from ad_conversion_dispatches where organization_id=$1`, [t.org]);
    await pool.query(`delete from ad_platform_connections where organization_id=$1`, [t.org]);
    await pool.query(`delete from calendar_appointments where organization_id=$1`, [t.org]);
    await pool.query(`delete from contacts where organization_id=$1`, [t.org]);
    await pool.query(`delete from user_organizations where organization_id=$1`, [t.org]);
    await pool.query(`delete from organizations where id=$1`, [t.org]);
    await pool.query(`delete from auth.users where id=$1`, [t.usuario]);
  }
  await pool.end();
});

describe("conversão de agendamento (0391)", () => {
  it("as colunas novas existem, e os segredos do Google são bytea", async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name in ('ad_platform_connections','ad_conversion_dispatches')
          and column_name in ('google_customer_id','google_conversion_action_id','google_oauth_client_secret_encrypted',
                              'google_refresh_token_encrypted','google_developer_token_encrypted',
                              'appointment_id','attempts','next_attempt_at','sent_at','error_code')`,
    );
    const tipos = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    expect(Object.keys(tipos)).toHaveLength(10);
    expect(tipos.google_oauth_client_secret_encrypted).toBe("bytea");
    expect(tipos.google_refresh_token_encrypted).toBe("bytea");
    expect(tipos.google_developer_token_encrypted).toBe("bytea");
  });

  it("nem o administrador da própria organização lê as tabelas pelo client de sessão", async () => {
    await envio(A);
    await pool.query(
      `insert into ad_platform_connections(organization_id,platform,enabled) values($1,'google_ads',false)`,
      [A.org],
    );
    expect(await comoMembroDeA(`select count(*) from ad_conversion_dispatches`)).toBe("42501");
    expect(await comoMembroDeA(`select count(*) from ad_platform_connections`)).toBe("42501");
    expect(await comoMembroDeA(`select google_refresh_token_encrypted from ad_platform_connections`)).toBe("42501");
  });

  it("anon e authenticated não têm privilégio nenhum nas duas tabelas", async () => {
    const { rows } = await pool.query(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name in ('ad_platform_connections','ad_conversion_dispatches')
          and grantee in ('anon','authenticated','PUBLIC')`,
    );
    expect(rows).toEqual([]);
  });

  it("um envio por agendamento e plataforma; outra plataforma e outra organização passam", async () => {
    expect(await codigoDoErro(() => envio(A))).toBe("23505");
    await envio(A, "google_ads");
    await envio(B);
    const { rows } = await pool.query(`select count(*)::int as n from ad_conversion_dispatches where appointment_id=$1`, [
      A.compromisso,
    ]);
    expect(rows[0].n).toBe(2);
  });

  it("a linha precisa de um alvo: lead ou agendamento", async () => {
    expect(await codigoDoErro(() => envio(A, "meta_ads", null))).toBe("23514");
  });

  it("apagar o compromisso leva a linha do livro junto, só da organização dele", async () => {
    await pool.query(`delete from calendar_appointments where id=$1`, [B.compromisso]);
    const { rows } = await pool.query(
      `select organization_id, count(*)::int as n from ad_conversion_dispatches
        where organization_id = any($1::uuid[]) group by organization_id`,
      [[A.org, B.org]],
    );
    expect(rows).toEqual([{ organization_id: A.org, n: 2 }]);
  });

  it("o kind novo da Central entra, com um aviso aberto por organização", async () => {
    const aviso = (t: typeof A) =>
      pool.query(
        `insert into agent_inbox_items(organization_id,kind,severity,title,body) values($1,'ad_conversion_failing','warn','t','b')`,
        [t.org],
      );
    await aviso(A);
    expect(await codigoDoErro(() => aviso(A))).toBe("23505");
    await aviso(B);
    await pool.query(
      `update agent_inbox_items set status='resolved', resolved_at=now() where organization_id=$1 and kind='ad_conversion_failing'`,
      [A.org],
    );
    await aviso(A);
  });

  it("reaplicar o bloco do baseline NÃO desliga de novo uma conexão ligada", async () => {
    await pool.query(
      `insert into ad_platform_connections(organization_id,platform,enabled,dataset_id) values($1,'meta_ads',true,'1234567')`,
      [B.org],
    );
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const inicio = baseline.indexOf("-- ---- conversão de agendamento para Meta e Google (migration 0391) ----");
    const fim = baseline.indexOf("-- ---- fim: conversão de agendamento (migration 0391) ----");
    expect(inicio).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(inicio);
    await pool.query(baseline.slice(inicio, fim));
    const { rows } = await pool.query(
      `select enabled from ad_platform_connections where organization_id=$1 and platform='meta_ads'`,
      [B.org],
    );
    expect(rows[0].enabled).toBe(true);
  });
});
