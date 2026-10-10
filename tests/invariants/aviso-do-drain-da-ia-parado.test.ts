import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  sincronizarAvisoDoDrain,
  TITULO_DRAIN_PARADO,
} from "@/lib/agent-engine/edge/crm/vigilancia-do-drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * O AVISO "AS RESPOSTAS AUTOMÁTICAS DA IA ESTÃO PARADAS" CONTRA O BANCO DE VERDADE.
 *
 * O teste unitário (`vigilancia-do-drain.test.ts`) mede a forma do SQL com um
 * pool de mentira. SQL não se prova com dublê: aqui o emissor de produção roda
 * contra o `baseline.sql`, que é onde uma constraint de `agent_inbox_items`
 * (kind, severity, coluna obrigatória) reprovaria o insert em silêncio, porque
 * o emissor engole a falha como `warn` de propósito.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG = "d2a10000-0000-4000-8000-00000000000a";

const avisosDaOrg = async () =>
  (
    await pool.query<{ status: string; resolved_at: Date | null; severity: string }>(
      `select status, resolved_at, severity from agent_inbox_items
        where organization_id = $1 and title = $2 order by created_at`,
      [ORG, TITULO_DRAIN_PARADO],
    )
  ).rows;

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where title = $1`, [TITULO_DRAIN_PARADO]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("aviso do drain da IA parado, no banco", () => {
  it("abre um por organização, não repete a cada batida, e se resolve sozinho", async () => {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, 'drain-parado', 'Drain parado', 'Drain parado')`,
      [ORG],
    );

    // Três batidas do reaper com o laço parado: um aviso só.
    await sincronizarAvisoDoDrain(pool, "parado", log);
    await sincronizarAvisoDoDrain(pool, "parado", log);
    await sincronizarAvisoDoDrain(pool, "parado", log);
    let avisos = await avisosDaOrg();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ status: "open", severity: "warn", resolved_at: null });

    // O laço voltou: o episódio fecha.
    await sincronizarAvisoDoDrain(pool, "saudavel", log);
    avisos = await avisosDaOrg();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.status).toBe("resolved");
    expect(avisos[0]!.resolved_at).not.toBeNull();

    // Novo episódio abre um aviso NOVO: o resolvido não deduplica.
    await sincronizarAvisoDoDrain(pool, "parado", log);
    expect((await avisosDaOrg()).map((a) => a.status)).toEqual(["resolved", "open"]);
  });
});
