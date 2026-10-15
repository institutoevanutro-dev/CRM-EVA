import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * EXCLUIR AGENDAMENTO LANÇADO POR ENGANO (migration 0364), MEDIDO NO POSTGRES.
 *
 * O que só o banco pode provar:
 *   - a constraint `calendar_appointments_exclusao_coerente`: excluído é sempre
 *     cancelado e sempre tem motivo. É ela que deixa toda leitura que já ignora
 *     `cancelled` (horários livres, lembretes, contexto da IA) ignorar o
 *     excluído sem filtro novo;
 *   - `fn_appointment_exclude`: gerente ou admin, organização do chamador,
 *     cancela pelo núcleo do cancelar (revisão e revisão do Google andam, que é
 *     o que tira o evento de lá e fecha os follow-ups), idempotente;
 *   - `trg_appointment_exclusion_guard`: o UPDATE direto pela REST (a policy de
 *     update deixa ao `agent`) não exclui, não forja quem excluiu, e não desfaz;
 *   - `fn_inicio_agenda` não conta o excluído.
 *
 * Que reaplicar o baseline não abre janela para nada disto é o
 * `reaplicar-o-baseline-nao-abre-janela.test.ts`, que roda no mesmo `test:db`.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

const ORG = randomUUID();
const OUTRA = randomUUID();
const ADMIN = randomUUID();
const GERENTE = randomUUID();
const ATENDENTE = randomUUID();
const PRESTADOR = randomUUID();
const GERENTE_DA_OUTRA = randomUUID();

beforeAll(async () => {
  for (const [id, nome] of [
    [ORG, "Exclui"],
    [OUTRA, "Outra"],
  ]) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,$2,$2)",
      [id, nome],
    );
  }
  for (const [uid, org, papel] of [
    [ADMIN, ORG, "admin"],
    [GERENTE, ORG, "manager"],
    [ATENDENTE, ORG, "agent"],
    [PRESTADOR, ORG, "provider"],
    [GERENTE_DA_OUTRA, OUTRA, "manager"],
  ]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [uid, `${uid}@exclui.test`]);
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
      [uid, org, papel],
    );
  }
});

/** Um compromisso futuro do prestador, em hora livre e única. */
let hora = 0;
async function compromisso(org = ORG, status: "confirmed" | "cancelled" = "confirmed"): Promise<string> {
  hora += 2;
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,status,cancelled_at,cancellation_reason)
     values($1,$2,'Consulta de teste',date_trunc('hour',now())+make_interval(days=>10,hours=>$3::int),
            date_trunc('hour',now())+make_interval(days=>10,hours=>$3::int+1),$4,
            case when $4='cancelled' then now() end, case when $4='cancelled' then 'paciente desmarcou' end)
     returning id`,
    [org, org === ORG ? PRESTADOR : null, hora, status],
  );
  return rows[0]!.id;
}

/** SQL como o PostgREST faz: `authenticated` + o JWT em `request.jwt.claims`. */
async function como<T extends pg.QueryResultRow>(uid: string, sql: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await c.query<T>(sql, params);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const excluir = (uid: string, org: string, id: string, motivo = "lançado por engano") =>
  como<{ r: Record<string, unknown> }>(uid, "select fn_appointment_exclude($1,$2,$3) as r", [org, id, motivo]).then(
    (x) => x.rows[0]!.r,
  );

const ler = async (id: string) =>
  (
    await pool.query(
      `select status, cancelled_at, cancellation_reason, excluded_at, excluded_by_user_id, exclusion_reason,
              revision::int, google_local_revision::int from calendar_appointments where id=$1`,
      [id],
    )
  ).rows[0];

describe("a constraint: excluído é cancelado e tem motivo", () => {
  it("compromisso vivo não pode ser marcado excluído (nem pelo dono do banco)", async () => {
    const id = await compromisso();
    await expect(
      pool.query("update calendar_appointments set excluded_at=now(), exclusion_reason='teste' where id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "calendar_appointments_exclusao_coerente" });
  });

  it("excluído sem motivo é recusado", async () => {
    const id = await compromisso(ORG, "cancelled");
    await expect(
      pool.query("update calendar_appointments set excluded_at=now() where id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("fn_appointment_exclude", () => {
  it.each([
    ["atendente", ATENDENTE],
    ["prestador dono do compromisso", PRESTADOR],
  ])("%s não exclui (42501) e nada muda", async (_rotulo, uid) => {
    const id = await compromisso();
    const antes = await ler(id);
    await expect(excluir(uid, ORG, id)).rejects.toMatchObject({ code: "42501" });
    expect(await ler(id)).toEqual(antes);
  });

  it.each([
    ["gerente", GERENTE],
    ["admin", ADMIN],
  ])("%s exclui: cancela pelo núcleo (revisão e Google andam) e marca quem, quando e por quê", async (_r, uid) => {
    const id = await compromisso();
    const antes = await ler(id);
    await excluir(uid, ORG, id, "  teste do sistema ");
    const depois = await ler(id);
    expect(depois).toMatchObject({
      status: "cancelled",
      cancellation_reason: "teste do sistema",
      excluded_by_user_id: uid,
      exclusion_reason: "teste do sistema",
    });
    expect(depois.cancelled_at).toBeInstanceOf(Date);
    expect(depois.excluded_at).toBeInstanceOf(Date);
    expect(depois.revision).toBeGreaterThan(antes.revision);
    // A revisão publicável andou: é ela que manda o worker tirar o evento do Google.
    expect(depois.google_local_revision).toBeGreaterThan(antes.google_local_revision);
  });

  it("idempotente: excluir de novo devolve a mesma linha, com o primeiro motivo", async () => {
    const id = await compromisso();
    const primeira = await excluir(GERENTE, ORG, id, "teste do sistema");
    const segunda = await excluir(ADMIN, ORG, id, "outro motivo");
    expect(segunda.excluded_at).toBe(primeira.excluded_at);
    expect(segunda.exclusion_reason).toBe("teste do sistema");
    expect(segunda.excluded_by_user_id).toBe(GERENTE);
  });

  it("compromisso já cancelado também é excluído, e o motivo do cancelamento fica", async () => {
    const id = await compromisso(ORG, "cancelled");
    await excluir(GERENTE, ORG, id, "era teste");
    expect(await ler(id)).toMatchObject({
      status: "cancelled",
      cancellation_reason: "paciente desmarcou",
      exclusion_reason: "era teste",
      excluded_by_user_id: GERENTE,
    });
  });

  it("motivo curto é recusado (22023)", async () => {
    const id = await compromisso();
    await expect(excluir(GERENTE, ORG, id, " a ")).rejects.toMatchObject({ code: "22023" });
  });

  it("outra organização: pela própria, o compromisso alheio não existe; pela alheia, sem papel", async () => {
    const alheio = await compromisso(OUTRA);
    await expect(excluir(GERENTE, ORG, alheio)).rejects.toMatchObject({ code: "P0002" });
    await expect(excluir(GERENTE, OUTRA, alheio)).rejects.toMatchObject({ code: "42501" });
    expect((await ler(alheio)).excluded_at).toBeNull();
    // E o gerente da outra organização não alcança a desta.
    const daqui = await compromisso();
    await expect(excluir(GERENTE_DA_OUTRA, ORG, daqui)).rejects.toMatchObject({ code: "42501" });
  });

  it("anon não executa a função", async () => {
    const { rows } = await pool.query(
      "select has_function_privilege('anon','public.fn_appointment_exclude(uuid,uuid,text)','execute') as anon",
    );
    expect(rows[0].anon).toBe(false);
  });
});

describe("o UPDATE direto pela REST (a policy de update deixa ao agent)", () => {
  const marcarDireto = (uid: string, id: string, extra = "") =>
    como(uid, `update calendar_appointments set excluded_at=now(), exclusion_reason='direto'${extra} where id=$1`, [id]);

  it("o atendente não exclui por fora da função", async () => {
    const id = await compromisso(ORG, "cancelled");
    await expect(marcarDireto(ATENDENTE, id)).rejects.toMatchObject({ code: "42501" });
    expect((await ler(id)).excluded_at).toBeNull();
  });

  it("o gerente pode, mas quem excluiu vem da sessão, não do corpo", async () => {
    const id = await compromisso(ORG, "cancelled");
    await marcarDireto(GERENTE, id, `, excluded_by_user_id='${ADMIN}'`);
    expect((await ler(id)).excluded_by_user_id).toBe(GERENTE);
  });

  it("a marca é final: ninguém desfaz nem troca o motivo", async () => {
    const id = await compromisso();
    await excluir(GERENTE, ORG, id);
    await expect(
      como(ADMIN, "update calendar_appointments set excluded_at=null, exclusion_reason=null where id=$1", [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      como(ADMIN, "update calendar_appointments set exclusion_reason='outro motivo' where id=$1", [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("nasce excluído? não: INSERT com a marca é recusado", async () => {
    await expect(
      pool.query(
        `insert into calendar_appointments(organization_id,title,starts_at,ends_at,status,cancelled_at,excluded_at,exclusion_reason)
         values($1,'x',now()+interval '30 days',now()+interval '30 days 1 hour','cancelled',now(),now(),'teste')`,
        [ORG],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("os números de Início", () => {
  it("fn_inicio_agenda não conta o excluído, e conta o cancelado de verdade", async () => {
    const org = randomUUID();
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Inicio','Inicio')",
      [org],
    );
    const ins = (status: string) =>
      pool.query<{ id: string }>(
        `insert into calendar_appointments(organization_id,title,starts_at,ends_at,status,cancelled_at)
         values($1,'x',now()+interval '1 hour',now()+interval '2 hours',$2,case when $2='cancelled' then now() end) returning id`,
        [org, status],
      );
    await ins("confirmed");
    await ins("cancelled");
    const excluido = (await ins("cancelled")).rows[0]!.id;
    await pool.query("update calendar_appointments set excluded_at=now(), exclusion_reason='teste' where id=$1", [
      excluido,
    ]);
    const { rows } = await pool.query(
      "select sum(marcadas)::int as marcadas, sum(canceladas)::int as canceladas from fn_inicio_agenda($1, now(), now()+interval '1 day')",
      [org],
    );
    expect(rows[0]).toEqual({ marcadas: 1, canceladas: 1 });
  });
});
