import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { pendentesVencidos } from "@/lib/agenda/expiracao-de-pendentes";

/**
 * O PEDIDO PENDENTE EXPIRA DE VERDADE, E SÓ QUANDO DEVE: medido no Postgres.
 *
 * ─── O incidente (12/10/2026, uma clínica) ──────────────────────────────────
 *
 * O cron `agenda-expira-pendentes` tinha dois defeitos, e um escondia o outro:
 *
 * (A) Cancelava com um UPDATE cru de `status` sem `cancelled_at`. A constraint
 *     `calendar_appointments_cancelamento_coerente` recusa, e recusava o lote
 *     INTEIRO: nenhum pedido abandonado expirou, nunca.
 * (B) Contava o prazo de `created_at`. Naquele dia, 23 consultas CONFIRMADAS,
 *     criadas dois dias antes, foram rebaixadas a `pending` por um teste de
 *     integração. Pela régua elas já estavam vencidas, e só o defeito (A)
 *     impediu a rodada seguinte de cancelar 23 pacientes de uma vez.
 *
 * O teste da rota (mock) não enxergava nenhum dos dois: quem recusa em (A) é o
 * banco, e quem carimba o instante certo em (B) é um trigger. Por isso este
 * arquivo: ele mede a constraint, o trigger `trg_appointment_stamp`, a guarda de
 * revisão de `fn_appointment_change` e a guarda da agenda importada, com a
 * MESMA função de regra que a rota usa (`pendentesVencidos`).
 *
 * O que a rota faz em volta disso (teto por rodada, falha parcial, auditoria
 * só com efeito) está em `app/api/v1/cron/agenda-expira-pendentes/route.test.ts`.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

const MIN = 60_000;

async function organizacao(): Promise<{ org: string; dono: string }> {
  const org = randomUUID();
  const dono = randomUUID();
  await pool.query("insert into auth.users(id,email) values($1,$2)", [dono, `${dono}@expira.test`]);
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Expira','Expira')",
    [org],
  );
  return { org, dono };
}

/** Um compromisso futuro, em hora cheia (o `Date` do driver não guarda microssegundo). `extra` são colunas a mais, já em SQL. */
async function compromisso(
  t: { org: string; dono: string },
  status: "pending" | "confirmed",
  extra: Record<string, string> = {},
): Promise<string> {
  const colunas = Object.keys(extra);
  const { rows } = await pool.query(
    `insert into calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,status${colunas.map((c) => `,${c}`).join("")})
     values($1,$2,'Consulta',date_trunc('hour',now())+interval '3 days',date_trunc('hour',now())+interval '3 days 1 hour',$3${colunas.map((c) => `,${extra[c]}`).join("")})
     returning id`,
    [t.org, t.dono, status],
  );
  return rows[0].id;
}

/** A linha como a rota a lê (mesmas colunas, mesmos tipos de wire). */
async function linha(id: string) {
  const { rows } = await pool.query(
    "select id,organization_id,revision,revision_started_at,created_at,status,cancelled_at,cancellation_reason,starts_at,owner_user_id from calendar_appointments where id=$1",
    [id],
  );
  const r = rows[0];
  return {
    ...r,
    revision: Number(r.revision),
    revision_started_at: (r.revision_started_at as Date).toISOString(),
  };
}

/** Roda como `service_role`, o papel do cron (auth.uid() nulo). */
async function comoServiceRole<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** O cancelamento que a rota faz hoje: o caminho comum, com a revisão lida. */
const expira = (org: string, id: string, revision: number) =>
  comoServiceRole((c) =>
    c.query("select fn_appointment_change($1,$2,$3,$4)", [
      org,
      id,
      revision,
      { status: "cancelled", cancellation_reason: "Pedido expirado: ninguém confirmou dentro do prazo." },
    ]),
  );

describe("(A) o cancelamento satisfaz o banco", () => {
  it("o UPDATE que a rota fazia é recusado pela constraint, e o pedido fica pendente", async () => {
    const t = await organizacao();
    const id = await compromisso(t, "pending");

    // Letra por letra o que a rota mandava: status e motivo, SEM `cancelled_at`.
    const antigo = comoServiceRole((c) =>
      c.query(
        "update calendar_appointments set status='cancelled', cancellation_reason='Pedido expirado: ninguém confirmou dentro do prazo.' where id = any($1) and status='pending' and source<>'historical_import'",
        [[id]],
      ),
    );
    await expect(antigo).rejects.toMatchObject({
      code: "23514",
      constraint: "calendar_appointments_cancelamento_coerente",
    });
    expect((await linha(id)).status).toBe("pending");
  });

  it("pelo caminho comum o pedido abandonado é cancelado por inteiro e o horário volta", async () => {
    const t = await organizacao();
    const id = await compromisso(t, "pending");
    const antes = await linha(id);

    // Pendente OCUPA: o mesmo atendente no mesmo instante é recusado.
    const outroNoMesmoHorario = () =>
      pool.query(
        "insert into calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,status) values($1,$2,'Outro',$3,$3::timestamptz+interval '1 hour','confirmed')",
        [t.org, t.dono, antes.starts_at],
      );
    await expect(outroNoMesmoHorario()).rejects.toMatchObject({ code: "23505" });

    await expira(t.org, id, antes.revision);

    const depois = await linha(id);
    expect(depois.status).toBe("cancelled");
    expect(depois.cancelled_at).not.toBeNull();
    expect(depois.cancellation_reason).toMatch(/^Pedido expirado/);
    expect(depois.revision).toBe(antes.revision + 1);
    // E o horário está livre de novo.
    await expect(outroNoMesmoHorario()).resolves.toBeTruthy();
  });
});

describe("(B) o prazo conta de quando ficou pendente", () => {
  it("o incidente: criado há 2 dias como confirmado, rebaixado a pendente AGORA, não vence na rodada seguinte", async () => {
    const t = await organizacao();
    const id = await compromisso(t, "confirmed", {
      created_at: "now()-interval '2 days'",
      revision_started_at: "now()-interval '2 days'",
    });
    await pool.query("update calendar_appointments set status='pending' where id=$1", [id]);

    const l = await linha(id);
    const prazo = new Map([[t.org, 1440]]);
    const agora = Date.now();

    // Controle: pela régua ANTIGA (`created_at`) esta linha estava vencida.
    expect((l.created_at as Date).getTime() + 1440 * MIN).toBeLessThan(agora);

    // Pela régua nova o relógio começou no rebaixamento.
    expect(agora - Date.parse(l.revision_started_at)).toBeLessThan(5 * MIN);
    expect(pendentesVencidos([l], prazo, agora)).toEqual([]);
    expect(pendentesVencidos([l], prazo, agora + 1439 * MIN)).toEqual([]);
    // E vence só depois de passado o prazo DESDE o rebaixamento.
    expect(pendentesVencidos([l], prazo, Date.parse(l.revision_started_at) + 1440 * MIN)).toEqual([l]);
  });

  it("nenhum UPDATE atrasa o relógio: quem manda em `revision_started_at` é o trigger", async () => {
    const t = await organizacao();
    const id = await compromisso(t, "pending");
    const antes = await linha(id);

    await pool.query(
      "update calendar_appointments set revision_started_at=now()-interval '30 days', notes='x' where id=$1",
      [id],
    );
    expect((await linha(id)).revision_started_at).toBe(antes.revision_started_at);
  });

  it("o prazo de uma organização não vale para a linha de outra", async () => {
    const rapida = await organizacao();
    const lenta = await organizacao();
    const haDuasHoras = { revision_started_at: "now()-interval '2 hours'" };
    const a = await linha(await compromisso(rapida, "pending", haDuasHoras));
    const b = await linha(await compromisso(lenta, "pending", haDuasHoras));

    const vencidos = pendentesVencidos(
      [a, b],
      new Map([
        [rapida.org, 60],
        [lenta.org, 1440],
      ]),
      Date.now(),
    );
    expect(vencidos.map((v) => v.id)).toEqual([a.id]);

    // E o cancelamento é preso à organização: pedir a linha de uma pela outra não acha nada.
    await expect(expira(lenta.org, a.id, a.revision)).rejects.toMatchObject({ code: "P0002" });
    expect((await linha(a.id)).status).toBe("pending");
  });
});

describe("as travas do banco contra cancelar o que não devia", () => {
  it("confirmado entre a leitura e a escrita: a revisão mudou, o banco recusa e ele fica confirmado", async () => {
    const t = await organizacao();
    const id = await compromisso(t, "pending", { revision_started_at: "now()-interval '3 days'" });
    const lido = await linha(id);

    await pool.query("update calendar_appointments set status='confirmed' where id=$1", [id]);

    await expect(expira(t.org, id, lido.revision)).rejects.toMatchObject({ code: "40001" });
    const depois = await linha(id);
    expect(depois.status).toBe("confirmed");
    expect(depois.cancelled_at).toBeNull();
  });

  it("agenda importada pendente e no passado não é cancelável nem pelo caminho comum", async () => {
    const t = await organizacao();
    const { rows } = await pool.query(
      `insert into calendar_appointments(organization_id,title,starts_at,ends_at,status,source,history_import_key)
       values($1,'Histórico',now()-interval '30 days',now()-interval '30 days'+interval '1 hour','pending','historical_import',$2)
       returning id,revision`,
      [t.org, "a".repeat(64)],
    );
    await expect(expira(t.org, rows[0].id, Number(rows[0].revision))).rejects.toMatchObject({
      message: expect.stringContaining("history_import_read_only"),
    });
    expect((await linha(rows[0].id)).status).toBe("pending");
  });
});

describe("a primeira rodada depois do deploy, num banco como o de produção", () => {
  it("sem pendente futuro, com pendentes importados e passados: a leitura da rota não devolve nada", async () => {
    const t = await organizacao();
    // O que produção tinha em 12/10/2026: consultas futuras confirmadas (criadas
    // dias antes) e 8 pendentes da agenda importada, com data passada.
    await compromisso(t, "confirmed", { created_at: "now()-interval '2 days'" });
    for (let i = 0; i < 8; i++) {
      await pool.query(
        `insert into calendar_appointments(organization_id,title,starts_at,ends_at,status,source,history_import_key)
         values($1,'Histórico',now()-make_interval(days=>30+$2),now()-make_interval(days=>30+$2)+interval '1 hour','pending','historical_import',$3)`,
        [t.org, i, String(i).repeat(64)],
      );
    }
    // E um pendente comum cuja hora já passou: não segura horário, não é tocado.
    await pool.query(
      "insert into calendar_appointments(organization_id,title,starts_at,ends_at,status) values($1,'Passou',now()-interval '5 days',now()-interval '5 days'+interval '1 hour','pending')",
      [t.org],
    );

    // Os MESMOS filtros da rota (presos por valor em `route.test.ts`).
    const { rows } = await pool.query(
      "select id from calendar_appointments where organization_id=$1 and status='pending' and source<>'historical_import' and starts_at>now()",
      [t.org],
    );
    expect(rows).toEqual([]);
  });
});
