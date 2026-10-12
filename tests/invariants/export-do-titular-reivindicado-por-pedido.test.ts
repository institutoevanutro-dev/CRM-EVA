import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A REIVINDICAÇÃO DO EXPORT DO TITULAR CONTRA O BANCO DE VERDADE.
 * Porte de melgarafael/DeskcommCRM #2752 (migration 0355 aqui).
 *
 * O teste unitário (`workers/lgpd-export-worker.test.ts`) roda o worker com um
 * banco falso que imita os filtros do PostgREST. Trava não se prova com dublê:
 * aqui o MESMO predicado que o worker manda (`status <> 'completed'` e
 * `export_claimed_at is null or < limite`) roda contra o `baseline.sql`, com
 * DUAS sessões disputando a mesma linha. É o Postgres que reavalia o predicado
 * da segunda contra a linha já comitada pela primeira; se a coluna não existir
 * ou o predicado mudar de forma, este arquivo fica vermelho.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "e2752000-0000-4000-8000-00000000000a";
const PEDIDO = "e2752000-0000-4000-8000-0000000000b1";

/** O UPDATE do worker, na forma que o PostgREST gera a partir dos filtros dele. */
const REIVINDICAR = `
  update lgpd_requests
     set status = 'processing', attempts = attempts + 1, export_claimed_at = now()
   where organization_id = $1 and id = $2
     and status <> 'completed'
     and (export_claimed_at is null or export_claimed_at < now() - interval '10 minutes')
  returning id`;

const pedido = async () =>
  (
    await pool.query<{ status: string; attempts: number; export_claimed_at: Date | null }>(
      `select status, attempts, export_claimed_at from lgpd_requests where id = $1`,
      [PEDIDO],
    )
  ).rows[0]!;

const repor = (extra: string) =>
  pool.query(`update lgpd_requests set status = 'received', attempts = 0, ${extra} where id = $1`, [PEDIDO]);

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'export-reivindicado', 'Export reivindicado', 'Export reivindicado')`,
    [ORG],
  );
  await pool.query(
    `insert into lgpd_requests (id, organization_id, request_type, source, due_at)
     values ($1, $2, 'data_request', 'manual', now() + interval '7 days')`,
    [PEDIDO, ORG],
  );
});

afterAll(async () => {
  await pool.query(`delete from lgpd_requests where id = $1`, [PEDIDO]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("export do titular: um pedido, uma reivindicação", () => {
  it("duas sessões ao mesmo tempo: só uma reivindica, e attempts conta uma vez", async () => {
    await repor("export_claimed_at = null");
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // A reivindica e segura a linha sem confirmar: é a janela da corrida.
      await a.query("begin");
      const deA = await a.query(REIVINDICAR, [ORG, PEDIDO]);
      expect(deA.rowCount).toBe(1);

      // B manda o mesmo UPDATE e fica esperando a trava da linha.
      const esperaDeB = b.query(REIVINDICAR, [ORG, PEDIDO]);
      await new Promise((r) => setTimeout(r, 300));
      await a.query("commit");

      // Solta a trava: o Postgres reavalia o predicado de B contra a linha de A.
      const deB = await esperaDeB;
      expect(deB.rowCount, "o segundo evento também reivindicou o pedido").toBe(0);
    } finally {
      a.release();
      b.release();
    }
    const fim = await pedido();
    expect(fim.attempts).toBe(1);
    expect(fim.status).toBe("processing");
  });

  it("reivindicação fresca não é retomada; vencida e limpa são", async () => {
    await repor("export_claimed_at = now()");
    expect((await pool.query(REIVINDICAR, [ORG, PEDIDO])).rowCount).toBe(0);

    await repor("export_claimed_at = now() - interval '11 minutes'");
    expect((await pool.query(REIVINDICAR, [ORG, PEDIDO])).rowCount).toBe(1);

    // A falha do worker devolve o pedido a `received` e zera o marcador.
    await repor("export_claimed_at = null");
    expect((await pool.query(REIVINDICAR, [ORG, PEDIDO])).rowCount).toBe(1);
  });

  it("pedido concluído não é reivindicado, nem com o marcador vazio", async () => {
    await pool.query(
      `update lgpd_requests set status = 'completed', export_claimed_at = null where id = $1`,
      [PEDIDO],
    );
    expect((await pool.query(REIVINDICAR, [ORG, PEDIDO])).rowCount).toBe(0);
  });

  it("a organização faz parte da trava: outra organização não reivindica o pedido", async () => {
    await repor("export_claimed_at = null");
    const outra = "e2752000-0000-4000-8000-00000000000b";
    expect((await pool.query(REIVINDICAR, [outra, PEDIDO])).rowCount).toBe(0);
    expect((await pedido()).export_claimed_at).toBeNull();
  });
});
