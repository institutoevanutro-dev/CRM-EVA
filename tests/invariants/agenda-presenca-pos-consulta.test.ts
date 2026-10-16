import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import { runFollowupTick } from "@/lib/followup/engine";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_AGENT_A, GOV_ORG, GOV_SESSION } from "./gov-helpers";

/**
 * PRESENÇA CONFIRMADA INICIA O ACOMPANHAMENTO PÓS-CONSULTA (migration 0373).
 *
 * O caminho é o da falta (0224): `fn_appointment_change_core` emite o evento no
 * mesmo commit do desfecho, `fn_appointment_recover` decide sob o mutex do
 * contato e grava recibo por (compromisso, revisão). Aqui o desfecho é
 * `completed`, o evento é `appointment.attended` e o gatilho do fluxo é
 * `appointment_attended`.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
const DIA = 86_400_000;
const ORG_B = randomUUID();
const SESSION_B = randomUUID();

beforeAll(async () => {
  await seedGov();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Pós B','Pós B')",
    [ORG_B],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'waha','pos-consulta-b','WORKING','\\x00'::bytea)",
    [SESSION_B, ORG_B],
  );
});
afterAll(() => pool.end());

async function fixture() {
  const contact = randomUUID(),
    conversation = randomUUID(),
    id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Pós-consulta')", [
    contact,
    GOV_ORG,
  ]);
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1,$2,$3,$4,'Consulta',now()-interval '2 hours',now()-interval '1 hour','confirmed')",
    [id, GOV_ORG, contact, conversation],
  );
  return { contact, conversation, id };
}

/** O desfecho pela porta da equipe: sessão autenticada, CAS de revisão. */
async function change(id: string, revision: number, patch: Record<string, unknown>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GOV_AGENT_A, role: "authenticated" }),
    ]);
    const r = await c.query("select fn_appointment_change($1,$2,$3,$4) result", [GOV_ORG, id, revision, patch]);
    await c.query("commit");
    return r.rows[0].result;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function eventos(id: string, tipo: string) {
  return (
    await pool.query(
      "select id from event_log where organization_id=$1 and entity_id=$2 and event_type=$3 order by created_at",
      [GOV_ORG, id, tipo],
    )
  ).rows.map((r) => r.id as string);
}

async function recover(id: string, org = GOV_ORG) {
  const [ultimo] = (await eventos(id, "appointment.attended")).slice(-1);
  return (await pool.query("select fn_appointment_recover($1,$2) result", [org, ultimo])).rows[0].result;
}

const GRAFO = {
  nodes: [
    { id: "t", type: "trigger", label: "Compareceu", position: { x: 0, y: 0 }, config: {} },
    {
      id: "w7",
      type: "wait",
      label: "7 dias",
      position: { x: 0, y: 1 },
      config: { mode: "fixed", duration_ms: 7 * DIA, anchor: "appointment_starts_at" },
    },
    { id: "end", type: "end", label: "Fim", position: { x: 0, y: 2 }, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "e1", source: "t", target: "w7", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "w7", target: "end", priority: 0, condition: { type: "always" } },
  ],
};

/** Fluxo `appointment_attended` armado por um agente publicado. */
async function flow(
  org = GOV_ORG,
  session = GOV_SESSION,
  params?: Record<string, unknown>,
  kind = "appointment_attended",
) {
  const v = (
    await pool.query("insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id", [
      org,
      GRAFO,
    ])
  ).rows[0].id;
  const p = (
    await pool.query(
      "insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config) values($1,'Pós-consulta '||gen_random_uuid(),'active',$2,$3) returning id",
      [org, v, { kind, ...(params ? { params } : {}) }],
    )
  ).rows[0].id;
  const agent = (
    await pool.query(
      "insert into ai_agents(organization_id,name,system_prompt) values($1,'Pós-consulta '||gen_random_uuid(),'Prompt') returning id",
      [org],
    )
  ).rows[0].id;
  await pool.query(
    "insert into ai_agent_versions(organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,1,'Prompt','anthropic','claude-sonnet-4-6',$3,'published',$4)",
    [org, agent, session, { enabled: true, flow_pointer_ids: [p] }],
  );
  return p as string;
}

async function stopFlows() {
  await pool.query(
    "update followup_flow_pointers set status='disabled' where trigger_config->>'kind' in ('appointment_attended','appointment_no_show')",
  );
}

describe("presença confirmada inicia o acompanhamento pós-consulta", () => {
  it("compareceu emite UM evento de presença (e nenhum de falta) no mesmo commit do desfecho", async () => {
    const a = await fixture();
    const r = await change(a.id, 1, { status: "completed" });
    expect(r).toMatchObject({ status: "completed", revision: 2, outcome_user_id: GOV_AGENT_A });
    expect(await eventos(a.id, "appointment.attended")).toHaveLength(1);
    expect(await eventos(a.id, "appointment.outcome_confirmed")).toHaveLength(0);
  });

  it("inscreve o contato preso à consulta, uma vez só — o recibo é a idempotência", async () => {
    await stopFlows();
    const pointer = await flow();
    const a = await fixture();
    await change(a.id, 1, { status: "completed" });

    const primeiro = await recover(a.id);
    expect(primeiro).toMatchObject({ result: "started", pointer_id: pointer, appointment_revision: 2 });
    const segundo = await recover(a.id);
    expect(segundo.enrollment_id).toBe(primeiro.enrollment_id);

    const inscricoes = (
      await pool.query(
        "select id,contact_id,appointment_revision::int rev,status from followup_enrollments where organization_id=$1 and appointment_id=$2",
        [GOV_ORG, a.id],
      )
    ).rows;
    expect(inscricoes).toHaveLength(1);
    expect(inscricoes[0]).toMatchObject({ contact_id: a.contact, rev: 2, status: "active" });
    const enrolled = (
      await pool.query(
        "select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='enrolled'",
        [GOV_ORG, primeiro.enrollment_id],
      )
    ).rows;
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0].payload).toMatchObject({ trigger_kind: "appointment_attended", appointment_id: a.id });
  });

  it("a espera ancorada conta da data da consulta, não de agora nem da reserva", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id, 1, { status: "completed" });
    const rec = await recover(a.id);
    expect(rec.result).toBe("started");

    // Dois ticks: o primeiro sai do gatilho, o segundo executa a espera.
    for (let rodada = 0; rodada < 2; rodada += 1) {
      await pool.query(
        "update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1 and status = 'active'",
        [rec.enrollment_id],
      );
      await runFollowupTick(
        { db: createPgAdminClient(pool), clock: () => new Date(), enqueueJob: async () => {} },
        { limit: 10 },
      );
    }
    const linha = (
      await pool.query(
        "select e.current_node_id, e.status, e.next_eval_at, a.starts_at from followup_enrollments e join calendar_appointments a on a.id=e.appointment_id where e.id=$1",
        [rec.enrollment_id],
      )
    ).rows[0];
    expect(linha).toMatchObject({ current_node_id: "w7", status: "active" });
    expect(new Date(linha.next_eval_at).getTime()).toBe(new Date(linha.starts_at).getTime() + 7 * DIA);

    // Acordar antes da hora (o que `inbound_woke` faz: next_eval_at=agora, com o
    // marcador de wake) não adianta a mensagem: o motor volta a estacionar no
    // mesmo instante ancorado, sem sair do nó.
    const passos = (await pool.query("select steps_taken from followup_enrollments where id=$1", [rec.enrollment_id])).rows[0].steps_taken;
    await pool.query(
      "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key) values($1,$2,'w7','inbound_woke','{}',$3)",
      [GOV_ORG, rec.enrollment_id, `w7:${passos}:wake`],
    );
    await pool.query("update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1", [rec.enrollment_id]);
    await runFollowupTick(
      { db: createPgAdminClient(pool), clock: () => new Date(), enqueueJob: async () => {} },
      { limit: 10 },
    );
    const depois = (
      await pool.query("select current_node_id, status, next_eval_at from followup_enrollments where id=$1", [rec.enrollment_id])
    ).rows[0];
    expect(depois).toMatchObject({ current_node_id: "w7", status: "active" });
    expect(new Date(depois.next_eval_at).getTime()).toBe(new Date(linha.starts_at).getTime() + 7 * DIA);
  });

  it("filtro de tipo de compromisso: fora do filtro não inicia, e presença sem fluxo não vira aviso nem recibo", async () => {
    await stopFlows();
    await flow(GOV_ORG, GOV_SESSION, { event_type_ids: [randomUUID()] });
    const a = await fixture();
    await change(a.id, 1, { status: "completed" });
    expect((await recover(a.id)).result).toBe("not_configured");
    expect(
      (await pool.query("select count(*)::int n from appointment_recovery_receipts where appointment_id=$1", [a.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query("select count(*)::int n from agent_inbox_items where ref_id=$1", [a.id])).rows[0].n,
    ).toBe(0);
  });

  it("organização: fluxo armado em OUTRA organização não arma esta, e o evento não é lido de fora", async () => {
    await stopFlows();
    await flow(ORG_B, SESSION_B);
    const a = await fixture();
    await change(a.id, 1, { status: "completed" });
    await expect(recover(a.id, ORG_B)).rejects.toMatchObject({ message: "appointment_source_event_missing" });
    expect((await recover(a.id)).result).toBe("not_configured");
    expect(
      (await pool.query("select count(*)::int n from followup_enrollments where appointment_id=$1", [a.id])).rows[0].n,
    ).toBe(0);
  });

  it("contato com OUTRO acompanhamento vivo (não pós-consulta): não inicia, e a equipe vê o porquê na Central", async () => {
    await stopFlows();
    await flow();
    await flow(GOV_ORG, GOV_SESSION, undefined, "appointment_no_show");
    const a = await fixture();
    // Uma falta anterior abriu a recuperação: esse é o "outro acompanhamento".
    await change(a.id, 1, { status: "no_show" });
    const [falta] = await eventos(a.id, "appointment.outcome_confirmed");
    const recuperacao = (await pool.query("select fn_appointment_recover($1,$2) result", [GOV_ORG, falta])).rows[0].result;
    expect(recuperacao.result).toBe("started");

    const segunda = (
      await pool.query(
        "insert into calendar_appointments(organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1,$2,$3,'Retorno',now()-interval '2 hours',now()-interval '1 hour','confirmed') returning id",
        [GOV_ORG, a.contact, a.conversation],
      )
    ).rows[0].id;
    await change(segunda, 1, { status: "completed" });
    expect((await recover(segunda)).result).toBe("other_flow");
    const aviso = (
      await pool.query(
        "select title, appointment_revision::int rev from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='appointment_recovery_review'",
        [GOV_ORG, segunda],
      )
    ).rows;
    expect(aviso).toHaveLength(1);
    expect(aviso[0]).toMatchObject({ title: "O acompanhamento pós-consulta não foi iniciado", rev: 2 });
    expect(
      (await pool.query("select status from followup_enrollments where id=$1", [recuperacao.enrollment_id])).rows[0].status,
    ).toBe("active");
  });

  it("NOVA presença recomeça a régua: a inscrição da consulta anterior é cancelada e a nova nasce", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id, 1, { status: "completed" });
    const antiga = await recover(a.id);
    expect(antiga.result).toBe("started");

    const segunda = (
      await pool.query(
        "insert into calendar_appointments(organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1,$2,$3,'Retorno',now()-interval '2 hours',now()-interval '1 hour','confirmed') returning id",
        [GOV_ORG, a.contact, a.conversation],
      )
    ).rows[0].id;
    await change(segunda, 1, { status: "completed" });
    const nova = await recover(segunda);
    expect(nova.result).toBe("started");
    expect(nova.enrollment_id).not.toBe(antiga.enrollment_id);

    const linhas = (
      await pool.query(
        "select appointment_id, status, cancel_reason from followup_enrollments where organization_id=$1 and contact_id=$2 order by started_at",
        [GOV_ORG, a.contact],
      )
    ).rows;
    expect(linhas).toEqual([
      {
        appointment_id: a.id,
        status: "cancelled",
        cancel_reason: "O paciente compareceu a uma nova consulta; o acompanhamento recomeçou por ela.",
      },
      { appointment_id: segunda, status: "active", cancel_reason: null },
    ]);
    // Nenhum aviso: recomeçar não é pendência.
    expect(
      (await pool.query("select count(*)::int n from agent_inbox_items where ref_id in ($1,$2)", [a.id, segunda])).rows[0].n,
    ).toBe(0);
  });

  it("consultas futuras (condição de reativação): conta pending/confirmed futuras do contato nesta organização", async () => {
    const a = await fixture();
    const db = createPgAdminClient(pool);
    expect(await db.countFutureAppointments!(GOV_ORG, a.contact)).toBe(0);
    await pool.query(
      "insert into calendar_appointments(organization_id,contact_id,title,starts_at,ends_at,status,cancelled_at) values($1,$2,'Retorno',now()+interval '3 days',now()+interval '3 days 1 hour','pending',null),($1,$2,'Cancelada',now()+interval '4 days',now()+interval '4 days 1 hour','cancelled',now())",
      [GOV_ORG, a.contact],
    );
    expect(await db.countFutureAppointments!(GOV_ORG, a.contact)).toBe(1);
    // Mesmo contato pedido de outra organização: nada.
    expect(await db.countFutureAppointments!(ORG_B, a.contact)).toBe(0);
  });

  it("desfazer a presença cancela a inscrição presa à consulta", async () => {
    await stopFlows();
    await flow();
    const a = await fixture();
    await change(a.id, 1, { status: "completed" });
    const rec = await recover(a.id);
    expect(rec.result).toBe("started");

    await change(a.id, 2, { status: "no_show" });
    const enr = (
      await pool.query("select status, cancel_reason from followup_enrollments where id=$1", [rec.enrollment_id])
    ).rows[0];
    expect(enr).toMatchObject({ status: "cancelled", cancel_reason: "O compromisso mudou. Revise o próximo passo." });
    // E a falta segue o caminho dela, com o evento dela.
    expect(await eventos(a.id, "appointment.outcome_confirmed")).toHaveLength(1);
  });
});
