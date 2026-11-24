import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A CLINICORP POR WEBHOOK (migration 0434) — medida no Postgres.
 *
 * 1. A clínica sem o módulo API Externa tem a linha da integração SEM credencial
 *    (só o endereço do webhook), e a ocupação continua podendo pendurar nela.
 * 2. Metade de credencial não existe: usuário sem token, ou token sem usuário.
 * 3. O que se guarda do endereço é um sha256 hex, e um mesmo hash não serve a
 *    duas organizações (é por ele que o receptor acha a organização).
 * 4. Os formatos medidos são uma lista.
 *
 * Organizações próprias (randomUUID): a da 0433 usa a do seed, e a integração é
 * uma por organização.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});

const ORG = randomUUID();
const OUTRA = randomUUID();
const HASH = "a".repeat(64);

const integracao = (org: string, colunas: Record<string, unknown>) => {
  const nomes = ["organization_id", ...Object.keys(colunas)];
  const valores = [org, ...Object.values(colunas)];
  return pool.query(
    `insert into calendar_clinicorp_integrations(${nomes.join(", ")}) values (${nomes.map((_, i) => `$${i + 1}`).join(", ")})`,
    valores,
  );
};

beforeAll(async () => {
  for (const org of [ORG, OUTRA]) {
    await pool.query("insert into organizations(id, slug, display_name, legal_name) values ($1, $2, 'Clínica', 'Clínica')", [
      org,
      `webhook-${org}`,
    ]);
  }
});

afterAll(() => pool.end());

describe("a integração só de webhook", () => {
  it("nasce sem credencial, e a ocupação pendura nela", async () => {
    await integracao(ORG, { webhook_token_hash: HASH });
    const r = await pool.query(
      "select api_user, api_token_encrypted, webhook_formatos from calendar_clinicorp_integrations where organization_id = $1",
      [ORG],
    );
    expect(r.rows[0]).toEqual({ api_user: null, api_token_encrypted: null, webhook_formatos: [] });

    const n = await pool.query("select public.fn_agenda_clinicorp_gravar($1, $2::jsonb) as n", [
      ORG,
      JSON.stringify([
        {
          external_id: "5001",
          professional_id: "9001",
          clinic_id: null,
          starts_at: "2030-03-12T13:00:00Z",
          ends_at: "2030-03-12T14:00:00Z",
          status: "confirmed",
          external_updated_at: null,
        },
      ]),
    ]);
    expect(n.rows[0].n).toBe(1);
  });

  it("o mesmo hash não serve a duas organizações", async () => {
    await expect(integracao(OUTRA, { webhook_token_hash: HASH })).rejects.toMatchObject({ code: "23505" });
  });

  it("o endereço se guarda só como sha256 hex", async () => {
    await expect(integracao(OUTRA, { webhook_token_hash: "token-em-claro" })).rejects.toMatchObject({ code: "23514" });
  });

  it("metade de credencial não existe", async () => {
    await expect(integracao(OUTRA, { api_user: "usuario-ficticio" })).rejects.toMatchObject({ code: "23514" });
    await expect(integracao(OUTRA, { api_token_encrypted: "\\x00" })).rejects.toMatchObject({ code: "23514" });
  });

  it("os formatos medidos são uma lista", async () => {
    await expect(
      pool.query("update calendar_clinicorp_integrations set webhook_formatos = '{}'::jsonb where organization_id = $1", [ORG]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
