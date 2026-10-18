import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * MIGRATION 0381: o título da página "Sobre" e a regra do RQE dos comentários.
 *
 * Duas peças, cada uma medida do jeito que a ameaça dela pede:
 *
 *   A1-A3  `platform_branding.nome_da_apresentacao`. O bloco do apêndice é LIDO
 *          do `supabase/baseline.sql` pelo rótulo (o texto que o `update.sh`
 *          aplica, não uma cópia) e reaplicado numa transação desfeita, depois
 *          de tirar a coluna. É o único jeito de ver o instante em que a coluna
 *          NASCE, que é o único em que ela pode ser semeada. Instalação nova e
 *          instalação que atualiza diferem só por existir organização nesse
 *          instante, e cada caso monta a sua dentro da transação. O banco do
 *          arquivo é cópia nova do molde, e o `rollback` devolve tudo.
 *   R1-R7  `fn_definir_medico_sem_rqe`, chamada como o PostgREST chama (papel
 *          `authenticated` e `request.jwt.claims`), o mesmo desenho de
 *          `paciente-pelo-cadastro.test.ts`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER ausente: rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

afterAll(async () => {
  await pool.end();
});

// ─── A: a coluna nasce semeada só em quem já tem organização ─────────────────

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO_0381 = "-- ---- nome da apresentação e regra do RQE (migration 0381) ----";

/** O bloco rotulado da 0381, do rótulo até o próximo rótulo de apêndice. */
function blocoDa0381(): string {
  const inicio = BASELINE.indexOf(ROTULO_0381);
  if (inicio === -1) throw new Error("rótulo da 0381 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0381, inicio + 1) !== -1) throw new Error("rótulo da 0381 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0381.length);
  if (fim === -1) throw new Error("fim do bloco da 0381 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** Marcador das linhas de resultado: a saída do psql traz também BEGIN, ALTER, DO... */
const MARCA = "SONDA|";

/** Roda `corpo` numa transação desfeita e devolve as linhas marcadas, sem a marca. */
function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Quem atualiza de uma versão anterior à 0381: a coluna ainda não existe. */
const SEM_A_COLUNA = "alter table public.platform_branding drop column nome_da_apresentacao;";

/** O valor da coluna na linha da instalação, ou a marca de que não há linha. */
const LER = `select '${MARCA}' || coalesce((select coalesce(nome_da_apresentacao, '<nulo>') from public.platform_branding where id = 1), '<sem linha>');`;

const ORGANIZACAO = `insert into public.organizations (id, slug, legal_name, display_name)
  values ('03810000-0000-4000-8000-0000000000a1', 'apresentacao-0381', 'Clínica Exemplo LTDA', 'Clínica Exemplo');`;

describe("platform_branding.nome_da_apresentacao (migration 0381)", () => {
  it("A1 · instalação que já existe: a coluna nasce com 'CRM Eva', e reaplicar não reescreve o que alguém trocou", () => {
    const bloco = blocoDa0381();
    expect(
      sondasDesfeitas(`
        ${SEM_A_COLUNA}
        ${ORGANIZACAO}
        insert into public.platform_branding (id, app_name, seeded_from_env) values (1, 'Marca da Instalação', false)
          on conflict (id) do update set app_name = excluded.app_name, seeded_from_env = excluded.seeded_from_env;
        ${bloco}
        ${LER}
        ${bloco}
        ${LER}
        update public.platform_branding set nome_da_apresentacao = 'Outro nome' where id = 1;
        ${bloco}
        ${LER}
        select '${MARCA}' || app_name || '/' || seeded_from_env::text from public.platform_branding where id = 1;
      `),
    ).toEqual(["CRM Eva", "CRM Eva", "Outro nome", "Marca da Instalação/false"]);
  });

  it("A2 · instalação que já existe sem linha de marca: a semeadura cria a linha com seeded_from_env = true, para o .env ainda completá-la", () => {
    expect(
      sondasDesfeitas(`
        ${SEM_A_COLUNA}
        delete from public.platform_branding;
        ${ORGANIZACAO}
        ${blocoDa0381()}
        select '${MARCA}' || nome_da_apresentacao || '/' || seeded_from_env::text || '/' || coalesce(app_name, '<nulo>')
          from public.platform_branding where id = 1;
      `),
    ).toEqual(["CRM Eva/true/<nulo>"]);
  });

  it("A3 · instalação nova: o apêndice roda antes de existir organização, a coluna nasce vazia e nunca é semeada depois", () => {
    const bloco = blocoDa0381();
    expect(
      sondasDesfeitas(`
        ${SEM_A_COLUNA}
        delete from public.organizations;
        insert into public.platform_branding (id, app_name, seeded_from_env) values (1, 'Marca da Instalação', true)
          on conflict (id) do update set app_name = excluded.app_name, seeded_from_env = excluded.seeded_from_env;
        ${bloco}
        ${LER}
        ${ORGANIZACAO}
        ${bloco}
        ${LER}
        select '${MARCA}' || count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'platform_branding' and column_name = 'nome_da_apresentacao';
      `),
    ).toEqual(["<nulo>", "<nulo>", "1"]);
  });
});

// ─── R: quem pode mudar a regra do RQE ───────────────────────────────────────

const ORG_A = "03810000-0000-4000-8000-00000000000a";
const ORG_B = "03810000-0000-4000-8000-00000000000b";
const ADMIN_A = "03811111-0000-4000-8000-000000000001";
const AGENT_A = "03811111-0000-4000-8000-000000000002";
const ADMIN_B = "03811111-0000-4000-8000-000000000003";

const RPC = "select public.fn_definir_medico_sem_rqe($1, $2)";

/** Roda SQL COMO o usuário, do jeito que o PostgREST fala com o banco. */
async function comoUsuario(
  uid: string | null,
  comando: string,
  params: unknown[],
  opcoes: { aal?: "aal1" | "aal2"; papel?: "authenticated" | "service_role" | "anon" } = {},
): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const papel = opcoes.papel ?? "authenticated";
    await c.query(`set local role ${papel}`);
    const claims =
      papel === "authenticated"
        ? { ...(uid ? { sub: uid } : {}), role: "authenticated", aal: opcoes.aal ?? "aal1" }
        : { role: papel };
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await c.query(comando, params);
    await c.query("commit");
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

describe("fn_definir_medico_sem_rqe (migration 0381)", () => {
  beforeAll(async () => {
    for (const u of [ADMIN_A, AGENT_A, ADMIN_B]) {
      await pool.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
        u,
        `${u}@regra-do-rqe.test`,
      ]);
    }
    for (const [org, slug] of [
      [ORG_A, "regra-do-rqe-a"],
      [ORG_B, "regra-do-rqe-b"],
    ] as const) {
      await pool.query(
        `insert into organizations (id, slug, legal_name, display_name, settings)
         values ($1, $2, 'Clínica Exemplo LTDA', 'Clínica Exemplo', $3::jsonb)
         on conflict (id) do nothing`,
        [org, slug, JSON.stringify({ visibility_mode: "all", comentarios: { preco: "Oi! Qual é o seu objetivo?" } })],
      );
    }
    for (const [u, org, papel] of [
      [ADMIN_A, ORG_A, "admin"],
      [AGENT_A, ORG_A, "agent"],
      [ADMIN_B, ORG_B, "admin"],
    ] as const) {
      await pool.query(
        `insert into user_organizations (user_id, organization_id, role, accepted_at)
         values ($1, $2, $3, now()) on conflict do nothing`,
        [u, org, papel],
      );
    }
  });

  it("R1 · o administrador da A desliga: a chave vira o booleano false, e o resto de settings fica como estava", async () => {
    const antes = await settingsDe(ORG_A);
    await comoUsuario(ADMIN_A, RPC, [ORG_A, false]);
    expect(await settingsDe(ORG_A)).toEqual({ ...antes, medico_sem_rqe: false });
    const { rows } = await pool.query<{ tipo: string }>(
      "select jsonb_typeof(settings -> 'medico_sem_rqe') as tipo from organizations where id = $1",
      [ORG_A],
    );
    expect(rows[0]!.tipo).toBe("boolean");
  });

  it("R2 · religar grava true, e a organização B não muda", async () => {
    const daB = await settingsDe(ORG_B);
    await comoUsuario(ADMIN_A, RPC, [ORG_A, true]);
    expect((await settingsDe(ORG_A)).medico_sem_rqe).toBe(true);
    expect(await settingsDe(ORG_B)).toEqual(daB);
  });

  it.each([
    ["agent da própria organização", AGENT_A],
    ["admin de OUTRA organização", ADMIN_B],
  ])("R3 · %s é recusado, e nada muda", async (_quem, uid) => {
    const antes = await settingsDe(ORG_A);
    await expect(comoUsuario(uid, RPC, [ORG_A, false])).rejects.toMatchObject({
      code: "42501",
      message: "medico_sem_rqe_forbidden",
    });
    expect(await settingsDe(ORG_A)).toEqual(antes);
  });

  it("R4 · sem sessão, e como service_role, a função recusa", async () => {
    const antes = await settingsDe(ORG_A);
    await expect(comoUsuario(null, RPC, [ORG_A, false])).rejects.toMatchObject({ code: "42501" });
    await expect(comoUsuario(null, RPC, [ORG_A, false], { papel: "service_role" })).rejects.toMatchObject({
      code: "42501",
    });
    expect(await settingsDe(ORG_A)).toEqual(antes);
  });

  it("R5 · anon não executa: permission denied, e nada muda", async () => {
    const antes = await settingsDe(ORG_A);
    await expect(comoUsuario(null, RPC, [ORG_A, false], { papel: "anon" })).rejects.toMatchObject({
      code: "42501",
      message: expect.stringContaining("permission denied for function fn_definir_medico_sem_rqe"),
    });
    expect(await settingsDe(ORG_A)).toEqual(antes);
  });

  it("R6 · o catálogo: anon e PUBLIC sem EXECUTE, authenticated com", async () => {
    const { rows } = await pool.query<{ anon: boolean; autenticado: boolean; publico: boolean }>(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as autenticado,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico
         from pg_proc p
        where p.oid = 'public.fn_definir_medico_sem_rqe(uuid, boolean)'::regprocedure`,
    );
    expect(rows[0]).toEqual({ anon: false, autenticado: true, publico: false });
  });

  it("R7 · administrador com fator TOTP verificado: aal1 recusa pela MFA, aal2 passa", async () => {
    const fator = randomUUID();
    await pool.query(
      "insert into auth.mfa_factors (id, user_id, status, factor_type) values ($1, $2, 'verified', 'totp')",
      [fator, ADMIN_A],
    );
    try {
      await expect(comoUsuario(ADMIN_A, RPC, [ORG_A, false])).rejects.toMatchObject({
        code: "42501",
        message: "medico_sem_rqe_mfa_required",
      });
      await comoUsuario(ADMIN_A, RPC, [ORG_A, false], { aal: "aal2" });
      expect((await settingsDe(ORG_A)).medico_sem_rqe).toBe(false);
    } finally {
      await pool.query("delete from auth.mfa_factors where id = $1", [fator]);
    }
  });
});
