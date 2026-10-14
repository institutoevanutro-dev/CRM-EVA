import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A IA MARCA ATENDIMENTO PRESENCIAL SEM SABER O `unit_id` — A UNIDADE SAI DA JORNADA.
 *
 * Medido em produção (Instituto Eva, 14/10/2026): todo tipo presencial tem
 * `required_room_kind`, o gatilho `fn_calendar_allocate_and_guard_resources`
 * recusa compromisso sem unidade (`agenda_unidade_obrigatoria`), e a IA não
 * tinha de onde tirar a unidade. Marcar pela API sem `unit_id` dava 409; com o
 * `unit_id` de Vitória, 201. Na conversa, a IA abria caso "confirmar unidade" e
 * às vezes dizia ao paciente que tinha marcado.
 *
 * Aqui o Postgres é real: quem decide se a linha entra é o gatilho de verdade,
 * não um dublê que aceitaria qualquer `unit_id`.
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

const ORG = "ea740000-0000-4000-8000-000000000001";
const SO_VITORIA = "ea740000-1111-4000-8000-000000000001";
const NAS_DUAS = "ea740000-1111-4000-8000-000000000002";
const VITORIA = "ea740000-2222-4000-8000-000000000001";
const SERRA = "ea740000-2222-4000-8000-000000000002";
const FUSO = "America/Sao_Paulo";

let tipo = "";
let contato = "";

function ctxDaIa(): HandlerCtx {
  return {
    organization_id: ORG,
    actor: { type: "ai_agent", id: "run-unidade", role: "agent" },
    requestId: "req-agenda-unidade",
  };
}

/**
 * Uma quarta-feira entre 7 e 13 dias à frente, às 10:00 de São Paulo (13:00Z):
 * longe do aviso mínimo e dentro da janela de reserva, em qualquer dia em que o
 * teste rode. Data fixa no passado faria a grade recusar pelo relógio.
 */
function quartaQueVem(minutoUtc = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(13, minutoUtc, 0, 0);
  return d.toISOString();
}

async function marcar(dono: string, extra: Record<string, unknown> = {}) {
  return marcarAgendamentoHandler(db, ctxDaIa(), {
    event_type_id: tipo,
    owner_user_id: dono,
    starts_at: quartaQueVem(),
    contact_id: contato,
    ...extra,
  }).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e: e as { code?: string; details?: Record<string, unknown> } }),
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'agenda-unidade', 'Agenda Unidade LTDA', 'Agenda Unidade') on conflict (id) do nothing`,
    [ORG],
  );
  for (const [id, email] of [
    [SO_VITORIA, "so-vitoria@invariant.test"],
    [NAS_DUAS, "nas-duas@invariant.test"],
  ] as const) {
    await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [id, email]);
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role) values ($1, $2, 'agent') on conflict do nothing`,
      [id, ORG],
    );
  }
  await pool.query(
    `insert into calendar_units (id, organization_id, name) values ($1, $3, 'Vitória'), ($2, $3, 'Serra')
     on conflict (id) do nothing`,
    [VITORIA, SERRA, ORG],
  );
  await pool.query(
    `insert into calendar_rooms (organization_id, unit_id, name, kind)
     values ($1, $2, 'Aplicação 1', 'application'), ($1, $3, 'Sala de aplicação', 'application')
     on conflict do nothing`,
    [ORG, VITORIA, SERRA],
  );

  const jornada = (windows: object[]) => JSON.stringify({ timezone: FUSO, windows });
  await pool.query(
    `insert into attendant_availability (organization_id, user_id, schedule) values
       ($1, $2, $4::jsonb), ($1, $3, $5::jsonb)
     on conflict (organization_id, user_id) do update set schedule = excluded.schedule`,
    [
      ORG,
      SO_VITORIA,
      NAS_DUAS,
      jornada([{ dow: 3, start: "09:00", end: "18:00", unit_id: VITORIA }]),
      // Configuração ambígua de propósito: o mesmo horário nas duas unidades.
      jornada([
        { dow: 3, start: "09:00", end: "18:00", unit_id: VITORIA },
        { dow: 3, start: "09:00", end: "18:00", unit_id: SERRA },
      ]),
    ],
  );

  const t = await pool.query<{ id: string }>(
    `insert into calendar_event_types
       (organization_id, slug, name, duration_minutes, required_room_kind, default_owner_user_id, is_active)
     values ($1, 'drenagem-unidade', 'Drenagem', 30, 'application', $2, true) returning id`,
    [ORG, SO_VITORIA],
  );
  tipo = t.rows[0]!.id;

  const c = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Paciente da unidade') returning id`,
    [ORG],
  );
  contato = c.rows[0]!.id;
});

afterAll(async () => {
  await pool.end();
});

describe("a unidade do compromisso presencial", () => {
  it("o cenário está montado", () => {
    expect(tipo).not.toBe("");
    expect(contato).not.toBe("");
  });

  it("sem `unit_id`, a unidade sai da janela da jornada que contém o horário, e o compromisso entra", async () => {
    const r = await marcar(SO_VITORIA);
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);

    const linha = await pool.query<{ unit_id: string | null; room_id: string | null }>(
      `select unit_id, room_id from calendar_appointments
        where organization_id = $1 and owner_user_id = $2 and starts_at = $3`,
      [ORG, SO_VITORIA, quartaQueVem()],
    );
    expect(linha.rows).toHaveLength(1);
    expect(linha.rows[0]!.unit_id).toBe(VITORIA);
    expect(linha.rows[0]!.room_id, "o gatilho escolheu a sala na unidade inferida").not.toBeNull();
  });

  it("com o `unit_id` de outra unidade que a da jornada, o horário não existe ali, e nada entra", async () => {
    const r = await marcar(SO_VITORIA, { unit_id: SERRA, starts_at: quartaQueVem(30) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e.code).toBe("agenda_horario_indisponivel");
  });

  it("com duas unidades possíveis, recusa dizendo quais, sem escolher por conta própria", async () => {
    const antes = await pool.query(`select count(*)::int as n from calendar_appointments where owner_user_id = $1`, [
      NAS_DUAS,
    ]);
    const r = await marcar(NAS_DUAS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e.code).toBe("agenda_unidade_obrigatoria");
    const unidades = (!r.ok ? (r.e.details?.unidades as { id: string }[]) : []).map((u) => u.id).sort();
    expect(unidades).toEqual([VITORIA, SERRA].sort());
    const depois = await pool.query(`select count(*)::int as n from calendar_appointments where owner_user_id = $1`, [
      NAS_DUAS,
    ]);
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });

  it("CONTROLE: com o `unit_id` escolhido entre as duas, entra", async () => {
    const r = await marcar(NAS_DUAS, { unit_id: SERRA });
    expect(r.ok, `recusado: ${JSON.stringify(!r.ok && r.e)}`).toBe(true);
  });
});
