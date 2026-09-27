/**
 * Entrada pela Conta EvaLink (migration 0285): as três funções security definer
 * que a rota de volta e o receptor de aviso chamam com a service role.
 *
 * Regras vigiadas: ligação só por `sub`, e-mail já cadastrado vira `conflito`,
 * papel gravado em TODOS os vínculos ativos (tudo ou nada quando isso deixaria
 * uma organização sem admin), e ninguém além da service role alcança nada disto.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => pool.end());

async function usuario(email = `evalink-${randomUUID()}@invariant.test`) {
  const id = randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}
async function organizacao() {
  const id = randomUUID();
  await pool.query(
    "insert into public.organizations (id, slug, legal_name, display_name) values ($1, $2, 'EvaLink teste', 'EvaLink teste')",
    [id, `evalink-${id}`],
  );
  return id;
}
async function membro(user: string, org: string, role: string, revogado = false) {
  await pool.query(
    "insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values ($1, $2, $3, now(), $4)",
    [user, org, role, revogado ? new Date() : null],
  );
}
async function ligar(user: string, sub: string) {
  await pool.query("insert into public.evalink_vinculos (user_id, evalink_sub) values ($1, $2)", [user, sub]);
}
async function entrada(sub: string, email: string, papel: string, orgPadrao: string) {
  const r = await pool.query("select * from public.fn_evalink_entrada($1, $2, $3, $4)", [sub, email, papel, orgPadrao]);
  return r.rows[0] as { user_id: string | null; motivo: string | null };
}
async function papeis(user: string) {
  const r = await pool.query(
    "select organization_id, role from public.user_organizations where user_id = $1 order by organization_id",
    [user],
  );
  return r.rows.map((l) => `${l.organization_id}:${l.role}`);
}

describe("fn_evalink_entrada", () => {
  it("pessoa nova com e-mail livre e org padrão existente: novo", async () => {
    const org = await organizacao();
    expect(await entrada(randomUUID(), `livre-${randomUUID()}@x.test`, "agent", org)).toEqual({
      user_id: null,
      motivo: "novo",
    });
  });

  it("org padrão inexistente: sem_org_padrao, antes de qualquer criação", async () => {
    expect(await entrada(randomUUID(), `livre-${randomUUID()}@x.test`, "agent", randomUUID())).toEqual({
      user_id: null,
      motivo: "sem_org_padrao",
    });
    const arquivada = await organizacao();
    await pool.query("update public.organizations set status = 'archived' where id = $1", [arquivada]);
    expect((await entrada(randomUUID(), `livre-${randomUUID()}@x.test`, "agent", arquivada)).motivo).toBe(
      "sem_org_padrao",
    );
  });

  it("e-mail já cadastrado (maiúsculas diferentes) sem vínculo: conflito e nada gravado", async () => {
    const org = await organizacao();
    const sub = randomUUID();
    const email = `Existe-${randomUUID()}@X.test`;
    await usuario(email.toLowerCase());
    expect(await entrada(sub, email, "agent", org)).toEqual({ user_id: null, motivo: "conflito" });
    const r = await pool.query("select 1 from public.evalink_vinculos where evalink_sub = $1", [sub]);
    expect(r.rowCount).toBe(0);
  });

  it("ligar_novo grava vínculo e papel; a entrada seguinte pelo mesmo sub entra", async () => {
    const org = await organizacao();
    const sub = randomUUID();
    const user = await usuario();
    await pool.query("select public.fn_evalink_ligar_novo($1, $2, $3, 'agent')", [user, sub, org]);
    const v = await pool.query("select user_id from public.evalink_vinculos where evalink_sub = $1", [sub]);
    expect(v.rows).toEqual([{ user_id: user }]);
    expect(await papeis(user)).toEqual([`${org}:agent`]);
    expect(await entrada(sub, "qualquer@x.test", "agent", org)).toEqual({ user_id: user, motivo: null });
  });

  it("ligado em duas organizações (viewer e agent) com papel manager: as duas viram manager", async () => {
    const [a, b] = [await organizacao(), await organizacao()];
    const sub = randomUUID();
    const user = await usuario();
    await ligar(user, sub);
    await membro(user, a, "viewer");
    await membro(user, b, "agent");
    expect(await entrada(sub, "x@x.test", "manager", a)).toEqual({ user_id: user, motivo: null });
    expect(await papeis(user)).toEqual([`${a}:manager`, `${b}:manager`].sort());
  });

  it("admin único numa organização e agent em outra, papel manager: ultimo_admin e nada muda", async () => {
    const [a, b] = [await organizacao(), await organizacao()];
    const sub = randomUUID();
    const user = await usuario();
    await ligar(user, sub);
    await membro(user, a, "admin");
    await membro(user, b, "agent");
    const antes = await papeis(user);
    expect(await entrada(sub, "x@x.test", "manager", a)).toEqual({ user_id: user, motivo: "ultimo_admin" });
    expect(await papeis(user)).toEqual(antes);
  });

  it("ligado sem nenhum vínculo ativo: sem_organizacao, nada criado", async () => {
    const org = await organizacao();
    const sub = randomUUID();
    const user = await usuario();
    await ligar(user, sub);
    await membro(user, org, "agent", true);
    expect(await entrada(sub, "x@x.test", "agent", org)).toEqual({ user_id: user, motivo: "sem_organizacao" });
    const r = await pool.query(
      "select count(*)::int as n from public.user_organizations where user_id = $1 and revoked_at is null",
      [user],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("papel fora do vocabulário lança", async () => {
    const org = await organizacao();
    await expect(entrada(randomUUID(), "x@x.test", "dono", org)).rejects.toThrow("evalink_papel_invalido");
    await expect(
      pool.query("select public.fn_evalink_ligar_novo($1, $2, $3, 'dono')", [randomUUID(), randomUUID(), org]),
    ).rejects.toThrow("evalink_papel_invalido");
  });
});

describe("fn_evalink_aviso", () => {
  it("derruba as sessões do ligado uma vez; id repetido não tem efeito; sub desconhecido não erra", async () => {
    const sub = randomUUID();
    const user = await usuario();
    await ligar(user, sub);
    for (let i = 0; i < 2; i++) {
      await pool.query("insert into auth.sessions (id, user_id, aal) values ($1, $2, 'aal1')", [randomUUID(), user]);
    }
    const aviso = randomUUID();
    const sessoes = async () =>
      (await pool.query("select count(*)::int as n from auth.sessions where user_id = $1", [user])).rows[0].n;

    const r1 = await pool.query("select * from public.fn_evalink_aviso($1, $2)", [sub, aviso]);
    expect(r1.rows).toEqual([{ user_id: user, novo: true }]);
    expect(await sessoes()).toBe(0);

    await pool.query("insert into auth.sessions (id, user_id, aal) values ($1, $2, 'aal1')", [randomUUID(), user]);
    const r2 = await pool.query("select * from public.fn_evalink_aviso($1, $2)", [sub, aviso]);
    expect(r2.rows[0].novo).toBe(false);
    expect(await sessoes()).toBe(1);

    const r3 = await pool.query("select * from public.fn_evalink_aviso($1, $2)", [randomUUID(), randomUUID()]);
    expect(r3.rows).toEqual([{ user_id: null, novo: true }]);
  });
});

describe("permissões", () => {
  async function como(role: string, comando: string, params: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${role}`);
      await c.query(comando, params);
      return true;
    } catch {
      return false;
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }
  const ENTRADA = "select * from public.fn_evalink_entrada($1, 'x@x.test', 'agent', $2)";

  for (const role of ["anon", "authenticated"]) {
    it(`${role} não lê as tabelas nem executa as funções`, async () => {
      const org = await organizacao();
      expect(await como(role, "select * from public.evalink_vinculos")).toBe(false);
      expect(await como(role, "select * from public.evalink_avisos_vistos")).toBe(false);
      expect(await como(role, ENTRADA, [randomUUID(), org])).toBe(false);
      expect(await como(role, "select public.fn_evalink_ligar_novo($1, $2, $3, 'agent')", [randomUUID(), randomUUID(), org])).toBe(false);
      expect(await como(role, "select * from public.fn_evalink_aviso($1, $2)", [randomUUID(), randomUUID()])).toBe(false);
    });
  }

  it("service_role executa", async () => {
    const org = await organizacao();
    expect(await como("service_role", ENTRADA, [randomUUID(), org])).toBe(true);
    expect(await como("service_role", "select * from public.fn_evalink_aviso($1, $2)", [randomUUID(), randomUUID()])).toBe(true);
  });
});
