import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_AGENT_A, GOV_ORG, GOV_SESSION } from "./gov-helpers";

/**
 * O ACOMPANHAMENTO DE CONSULTA ESCOLHE POR QUAL NÚMERO SAI (migration 0377).
 *
 * A conversa da consulta está no canal A (o da clínica); o fluxo fixa o canal B
 * (o número pessoal do médico) em `trigger_config.params.channel_session_id`.
 * A inscrição tem de nascer presa a uma conversa do contato NO B — é ela que o
 * envio segue. Canal fixado arquivado ou de outra organização volta ao A.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
const DIA = 86_400_000;
const ORG_B = randomUUID();
const SESSION_B = randomUUID();
const MEDICO = randomUUID();

beforeAll(async () => {
  await seedGov();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Pós B','Pós B')",
    [ORG_B],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,'waha','canal-fixado-outra-org-'||$1::text,'WORKING','\\x00'::bytea)",
    [SESSION_B, ORG_B],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,'waha','numero-do-medico-'||$1::text,'WORKING','\\x00'::bytea)",
    [MEDICO, GOV_ORG],
  );
});
afterAll(() => pool.end());

async function fixture() {
  const contact = randomUUID(),
    conversation = randomUUID(),
    id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1::uuid,$2,'Pós-consulta')", [
    contact,
    GOV_ORG,
  ]);
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1::uuid,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1::uuid,$2,$3,$4,'Consulta',now()-interval '2 hours',now()-interval '1 hour','confirmed')",
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
    "insert into ai_agent_versions(organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1::uuid,$2,1,'Prompt','anthropic','claude-sonnet-4-6',$3,'published',$4)",
    [org, agent, session, { enabled: true, flow_pointer_ids: [p] }],
  );
  return p as string;
}

async function stopFlows() {
  await pool.query(
    "update followup_flow_pointers set status='disabled' where trigger_config->>'kind' in ('appointment_attended','appointment_no_show')",
  );
}


async function canalArquivado() {
  const id = randomUUID();
  await pool.query(
    "insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,'waha','arquivado-'||$1::text,'WORKING','\\x00'::bytea)",
    [id, GOV_ORG],
  );
  return id;
}

/** Inscreve e devolve o canal da conversa a que a inscrição ficou presa. */
async function inscreve(params?: Record<string, unknown>, antesDoRecover?: () => Promise<void>) {
  await stopFlows();
  await flow(GOV_ORG, GOV_SESSION, params);
  const a = await fixture();
  await change(a.id, 1, { status: "completed" });
  await antesDoRecover?.();
  const rec = await recover(a.id);
  expect(rec.result).toBe("started");
  const linha = (
    await pool.query(
      `select e.conversation_id, e.service_boundary->>'conversation_id' boundary, c.channel_session_id, c.contact_id
         from followup_enrollments e join conversations c on c.id = e.conversation_id
        where e.organization_id=$1 and e.id=$2`,
      [GOV_ORG, rec.enrollment_id],
    )
  ).rows[0];
  expect(linha.boundary).toBe(linha.conversation_id);
  expect(linha.contact_id).toBe(a.contact);
  return { ...linha, consulta: a };
}

describe("o acompanhamento de consulta escolhe por qual número sai", () => {
  it("canal fixado B: a conversa nasce no B e a inscrição fica presa a ela", async () => {
    const r = await inscreve({ channel_session_id: MEDICO });
    expect(r.channel_session_id).toBe(MEDICO);
    expect(r.conversation_id).not.toBe(r.consulta.conversation);
  });

  it("sem canal fixado: segue o canal da conversa da consulta (A), como antes", async () => {
    const r = await inscreve();
    expect(r.channel_session_id).toBe(GOV_SESSION);
    expect(r.conversation_id).toBe(r.consulta.conversation);
  });

  it("canal fixado arquivado depois do desfecho: volta ao A", async () => {
    const arquivado = await canalArquivado();
    const r = await inscreve({ channel_session_id: arquivado }, async () => {
      await pool.query("update channel_sessions set archived_at=now() where id=$1", [arquivado]);
    });
    expect(r.channel_session_id).toBe(GOV_SESSION);
    expect(r.conversation_id).toBe(r.consulta.conversation);
  });

  it("canal fixado de OUTRA organização é ignorado: volta ao A, nada nasce na outra", async () => {
    const r = await inscreve({ channel_session_id: SESSION_B });
    expect(r.channel_session_id).toBe(GOV_SESSION);
    const vazou = await pool.query(
      "select 1 from conversations where channel_session_id=$1 and contact_id=$2",
      [SESSION_B, r.consulta.contact],
    );
    expect(vazou.rowCount).toBe(0);
  });

  it("valor que não é uuid não derruba a inscrição: volta ao A", async () => {
    const r = await inscreve({ channel_session_id: "nao-e-uuid" });
    expect(r.channel_session_id).toBe(GOV_SESSION);
  });
});
