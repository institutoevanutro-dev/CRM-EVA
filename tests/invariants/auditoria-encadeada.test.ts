import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

/**
 * Achado M9 (migration 0305): a trilha de auditoria tem prova de adulteração.
 * Cada caso roda numa transação desfeita no fim, para a adulteração de um não
 * vazar para o outro.
 */
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 2 });
afterAll(() => pool.end());

async function numaTransacao(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try { await c.query("begin"); await fn(c); } finally { await c.query("rollback"); c.release(); }
}
async function inserir(c: PoolClient, action: string, criadaHaDias = 0): Promise<{ id: string; cadeia_seq: number }> {
  const r = await c.query(
    "insert into api_audit_log(action, metadata, created_at) values ($1, '{\"x\":1}', now() - make_interval(days => $2)) returning id, cadeia_seq",
    [action, criadaHaDias]);
  return { id: r.rows[0].id, cadeia_seq: Number(r.rows[0].cadeia_seq) };
}
async function verificar(c: PoolClient) {
  return (await c.query("select public.fn_verificar_cadeia_auditoria() v")).rows[0].v as {
    total_problemas: number; problemas: { cadeia_seq: number; problema: string }[]; cabeca_seq: number;
  };
}

describe("trilha de auditoria encadeada", () => {
  it("linhas novas encadeiam em sequência e a cadeia íntegra não acusa nada", () => numaTransacao(async (c) => {
    const a = await inserir(c, "teste.a"), b = await inserir(c, "teste.b");
    expect(b.cadeia_seq).toBe(a.cadeia_seq + 1);
    const elo = await c.query("select (select hash_linha from api_audit_log where id=$1) = (select hash_anterior from api_audit_log where id=$2) ok", [a.id, b.id]);
    expect(elo.rows[0].ok).toBe(true);
    const v = await verificar(c);
    expect(v.total_problemas).toBe(0);
    expect(Number(v.cabeca_seq)).toBe(b.cadeia_seq);
  }));

  it("o hash é calculado pelo banco: quem insere não escolhe a posição nem o hash", () => numaTransacao(async (c) => {
    const antes = await inserir(c, "teste.antes");
    const r = await c.query("insert into api_audit_log(action, cadeia_seq, hash_linha) values ('teste.forjado', 999, '\\x00') returning cadeia_seq, encode(hash_linha,'hex') h");
    expect(Number(r.rows[0].cadeia_seq)).toBe(antes.cadeia_seq + 1);
    expect(r.rows[0].h).not.toBe("00");
    expect((await verificar(c)).total_problemas).toBe(0);
  }));

  it("linha alterada é acusada", () => numaTransacao(async (c) => {
    await inserir(c, "teste.a"); const b = await inserir(c, "teste.b"); await inserir(c, "teste.c");
    await c.query("update api_audit_log set metadata = '{\"x\":2}' where id=$1", [b.id]);
    expect((await verificar(c)).problemas).toContainEqual({ cadeia_seq: b.cadeia_seq, problema: "linha_alterada" });
  }));

  it("linha apagada do meio é acusada", () => numaTransacao(async (c) => {
    await inserir(c, "teste.a"); const b = await inserir(c, "teste.b"); await inserir(c, "teste.c");
    await c.query("delete from api_audit_log where id=$1", [b.id]);
    expect((await verificar(c)).problemas).toContainEqual({ cadeia_seq: b.cadeia_seq + 1, problema: "linha_removida" });
  }));

  it("referência que vira NULL (cascata) passa; trocada por outra, é acusada", () => numaTransacao(async (c) => {
    const org = (await c.query("select id from organizations limit 1")).rows[0]?.id
      ?? (await c.query("insert into organizations(slug,legal_name,display_name) values('m9','M9','M9') returning id")).rows[0].id;
    const r = await c.query("insert into api_audit_log(action, organization_id) values ('teste.org', $1) returning id, cadeia_seq", [org]);
    await c.query("update api_audit_log set organization_id = null where id=$1", [r.rows[0].id]);
    expect((await verificar(c)).total_problemas).toBe(0);
    await c.query("update api_audit_log set organization_id = $2 where id=$1", [r.rows[0].id, org]);
    expect((await verificar(c)).total_problemas).toBe(0);
    const outra = (await c.query("insert into organizations(slug,legal_name,display_name) values('m9-outra','Outra','Outra') returning id")).rows[0].id;
    await c.query("update api_audit_log set organization_id = $2 where id=$1", [r.rows[0].id, outra]);
    expect((await verificar(c)).problemas).toContainEqual({ cadeia_seq: Number(r.rows[0].cadeia_seq), problema: "referencia_alterada" });
  }));

  it("o expurgo apaga só o começo da cadeia, mesmo com data fora de ordem na fronteira", () => numaTransacao(async (c) => {
    await c.query("delete from api_audit_log");
    const velha1 = await inserir(c, "teste.velha1", 200), velha2 = await inserir(c, "teste.velha2", 200);
    const nova = await inserir(c, "teste.nova", 0);
    const fora = await inserir(c, "teste.fora_de_ordem", 200); // posição depois da nova, data antiga
    const apagadas = (await c.query("select public.fn_expurgar_auditoria_vencida(90, 1000) n")).rows[0].n;
    expect(apagadas).toBe(2);
    const sobrou = (await c.query("select id from api_audit_log order by cadeia_seq")).rows.map((x) => x.id);
    expect(sobrou).toEqual([nova.id, fora.id]);
    expect(sobrou).not.toContain(velha1.id); expect(sobrou).not.toContain(velha2.id);
    expect((await verificar(c)).total_problemas).toBe(0);
  }));
});
