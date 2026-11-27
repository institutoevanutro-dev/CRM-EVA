import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * QUEM CONVERTEU O LEAD (migration 0422), gravado pela rota de marcar.
 *
 * Pedido do dono da clínica em 21/11/2026: o "Novo agendamento" diz quem
 * converteu — alguém da equipe ou a IA —, que nem sempre é quem clicou em
 * Confirmar. O id da pessoa vem do CORPO do pedido, então a rota só aceita
 * membro ativo da organização; e a IA nunca escolhe pessoa.
 *
 * Postgres real: as CHECKs (`converted_by_kind` e a coerência IA sem pessoa)
 * são as do baseline aplicado.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
});
const db = pgComoSupabase(pool);

const ORG = "ea750000-0000-4000-8000-000000000001";
const OUTRA_ORG = "ea750000-0000-4000-8000-000000000002";
const RECEPCAO = "ea750000-1111-4000-8000-000000000001";
const COLEGA = "ea750000-1111-4000-8000-000000000002";
const DE_FORA = "ea750000-1111-4000-8000-000000000003";
const REVOGADA = "ea750000-1111-4000-8000-000000000004";
const FUSO = "America/Sao_Paulo";

let tipo = "";
let contato = "";

function ctxDe(actor: HandlerCtx["actor"]): HandlerCtx {
  return { organization_id: ORG, actor, requestId: "req-quem-converteu" };
}
const daRecepcao = () => ctxDe({ type: "user", id: RECEPCAO, role: "agent" });
const daIa = () => ctxDe({ type: "ai_agent", id: "run-quem-converteu", role: "agent" });

/** Uma quinta-feira entre 7 e 13 dias à frente, `hora` de São Paulo. */
function quintaQueVem(hora: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hora + 3, 0, 0, 0);
  return d.toISOString();
}

async function marcar(ctx: HandlerCtx, hora: number, extra: Record<string, unknown> = {}) {
  return marcarAgendamentoHandler(db, ctx, {
    event_type_id: tipo,
    owner_user_id: COLEGA,
    starts_at: quintaQueVem(hora),
    contact_id: contato,
    ...extra,
  }).then(
    (r) => ({ ok: true as const, r: r as { id: string } }),
    (e: unknown) => ({ ok: false as const, e: e as { code?: string } }),
  );
}

async function conversaoDe(id: string) {
  const r = await pool.query<{ converted_by_kind: string | null; converted_by_user_id: string | null }>(
    `select converted_by_kind, converted_by_user_id from calendar_appointments where id = $1`,
    [id],
  );
  return r.rows[0];
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'quem-converteu', 'Quem Converteu LTDA', 'Quem Converteu'),
       ($2, 'quem-converteu-outra', 'Outra LTDA', 'Outra')
     on conflict (id) do nothing`,
    [ORG, OUTRA_ORG],
  );
  for (const [id, email, org] of [
    [RECEPCAO, "recepcao@quem-converteu.test", ORG],
    [COLEGA, "colega@quem-converteu.test", ORG],
    [DE_FORA, "fora@quem-converteu.test", OUTRA_ORG],
    [REVOGADA, "revogada@quem-converteu.test", ORG],
  ] as const) {
    await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [id, email]);
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role) values ($1, $2, 'agent') on conflict do nothing`,
      [id, org],
    );
  }
  await pool.query(`update user_organizations set revoked_at = now() where user_id = $1 and organization_id = $2`, [
    REVOGADA,
    ORG,
  ]);
  await pool.query(
    `insert into attendant_availability (organization_id, user_id, schedule) values ($1, $2, $3::jsonb)
     on conflict (organization_id, user_id) do update set schedule = excluded.schedule`,
    [ORG, COLEGA, JSON.stringify({ timezone: FUSO, windows: [{ dow: 4, start: "08:00", end: "18:00" }] })],
  );
  const t = await pool.query<{ id: string }>(
    `insert into calendar_event_types
       (organization_id, slug, name, duration_minutes, location_kind, default_owner_user_id, is_active)
     values ($1, 'teleconsulta-converteu', 'Teleconsulta', 30, 'phone', $2, true) returning id`,
    [ORG, COLEGA],
  );
  tipo = t.rows[0]!.id;
  const c = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Paciente Fictício Converteu') returning id`,
    [ORG],
  );
  contato = c.rows[0]!.id;
});

afterAll(async () => {
  await pool.end();
});

describe("quem converteu o lead", () => {
  it("sem escolha, é quem está marcando", async () => {
    const r = await marcar(daRecepcao(), 9);
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);
    expect(await conversaoDe(r.ok ? r.r.id : "")).toEqual({ converted_by_kind: "user", converted_by_user_id: RECEPCAO });
  });

  it("outra pessoa DA EQUIPE é aceita", async () => {
    const r = await marcar(daRecepcao(), 10, { converted_by_kind: "user", converted_by_user_id: COLEGA });
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);
    expect(await conversaoDe(r.ok ? r.r.id : "")).toEqual({ converted_by_kind: "user", converted_by_user_id: COLEGA });
  });

  it("a IA do atendimento grava `ai`, sem pessoa", async () => {
    const r = await marcar(daRecepcao(), 11, { converted_by_kind: "ai", converted_by_user_id: COLEGA });
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);
    expect(await conversaoDe(r.ok ? r.r.id : "")).toEqual({ converted_by_kind: "ai", converted_by_user_id: null });
  });

  it("paciente antigo: `null` explícito grava as duas nulas (27/11/2026)", async () => {
    const r = await marcar(daRecepcao(), 15, { converted_by_kind: null, converted_by_user_id: COLEGA });
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);
    expect(await conversaoDe(r.ok ? r.r.id : "")).toEqual({ converted_by_kind: null, converted_by_user_id: null });
  });

  it("alguém de OUTRA organização é recusado, e nada entra", async () => {
    const r = await marcar(daRecepcao(), 12, { converted_by_kind: "user", converted_by_user_id: DE_FORA });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e.code).toBe("agenda_quem_converteu_fora_da_equipe");
    const linha = await pool.query(`select 1 from calendar_appointments where organization_id = $1 and starts_at = $2`, [
      ORG,
      quintaQueVem(12),
    ]);
    expect(linha.rows).toHaveLength(0);
  });

  it("quem saiu da equipe (revogado) também é recusado", async () => {
    const r = await marcar(daRecepcao(), 13, { converted_by_kind: "user", converted_by_user_id: REVOGADA });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e.code).toBe("agenda_quem_converteu_fora_da_equipe");
  });

  it("marcação pela IA é sempre `ai`, mesmo que o corpo diga outra pessoa", async () => {
    const r = await marcar(daIa(), 14, { converted_by_kind: "user", converted_by_user_id: COLEGA });
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);
    expect(await conversaoDe(r.ok ? r.r.id : "")).toEqual({ converted_by_kind: "ai", converted_by_user_id: null });
  });

  it("o banco recusa IA com pessoa (CHECK de coerência)", async () => {
    await expect(
      pool.query(
        `update calendar_appointments set converted_by_kind = 'ai', converted_by_user_id = $1
          where organization_id = $2`,
        [COLEGA, ORG],
      ),
    ).rejects.toThrow(/calendar_appointments_converted_by_coerente/);
  });
});
