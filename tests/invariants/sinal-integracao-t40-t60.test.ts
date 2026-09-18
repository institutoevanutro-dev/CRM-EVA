/** Integração chama helpers de produção. O transporte RPC abaixo só liga as
 * chamadas do Supabase às mesmas funções instaladas no Postgres do baseline. */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_SEM_BLOQUEIOS_OPCIONAIS,
  decidirEnvio,
  lerFatosDoEnvio,
  type ConfigDosBloqueios,
} from "@/lib/followup/bloqueios-obrigatorios";
import { listarReservasVencidas, abrirItemDeRevisao, type ReservaPendenteDeRevisao } from "@/lib/followup/revisao-do-sinal";
import type { FlowGraph } from "@/lib/followup/graph-schema";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { isolarFixtureDeFollowup } from "./followup-isolamento";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

// ---- seeds ----

let orgSeq = 0;

// UUID v4-like determinístico e legível: 8-4-4-4-12 hex, formato exato que a
// coluna `uuid` exige. `prefixoHex` (4 hex chars) distingue o cenário a olho
// nu num `select * from organizations`; `seq` evita colisão entre `it`s.
function idDeTeste(prefixoHex: string, seq: number): string {
  const s = seq.toString(16).padStart(4, "0");
  return `${prefixoHex}0000-0000-4000-8000-${s}00000001`;
}

async function seedOrg(org: string, settings?: unknown): Promise<void> {
  const name = `sinal-t40-t60-${org}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb))
     on conflict (id) do update set settings = excluded.settings`,
    [org, name, name, name, settings ? JSON.stringify(settings) : null],
  );
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, is_blocked) values ($1, 'Contato do Sinal', false) returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedEventType(org: string, requiresSignal: boolean): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_event_types (organization_id, name, slug, requires_signal)
     values ($1, 'Consulta', 'consulta-' || substr(gen_random_uuid()::text, 1, 8), $2)
     returning id`,
    [org, requiresSignal],
  );
  return rows[0]!.id;
}

/**
 * `criadaEm` é escrita por UPDATE depois do insert: a coluna tem
 * `default now()`, e é exatamente o instante que este teste precisa
 * controlar para simular T+40 e T+60 sem esperar o relógio de verdade.
 */
async function seedReserva(params: {
  org: string;
  contactId: string;
  eventTypeId: string;
  criadaEm: Date;
  consultaEm: Date;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments (organization_id, event_type_id, title, starts_at, ends_at, contact_id, created_at)
     values ($1, $2, 'Consulta com sinal', $3::timestamptz, $3::timestamptz + interval '30 minutes', $4, $3::timestamptz)
     returning id`,
    [params.org, params.eventTypeId, params.consultaEm.toISOString(), params.contactId],
  );
  const id = rows[0]!.id;
  await pool.query(`update calendar_appointments set created_at = $2 where id = $1`, [id, params.criadaEm.toISOString()]);
  return id;
}

const SIMPLE_GRAPH: FlowGraph = {
  nodes: [
    { id: "w1", type: "wait", label: "Wait", position: { x: 0, y: 0 }, config: { mode: "fixed", duration_ms: 600_000 } },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } }],
};

async function seedFluxoDoSinal(org: string): Promise<{ pointerId: string; versionId: string }> {
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(SIMPLE_GRAPH)],
  );
  const versionId = versionRows[0]!.id;
  // cancel_on_reply:true — sem isto o comprovante não bloquearia nada
  // sozinho (ver docs/specs/20-spec-supervisao-de-agente.md, seção da T+60).
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
     values ($1, $2, 'active', $3, $4) returning id`,
    [org, `Cobrança de sinal ${Date.now()}-${Math.random()}`, versionId, JSON.stringify({ kind: "manual", cancel_on_reply: true })],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedInscricaoDoSinal(params: {
  org: string;
  pointerId: string;
  versionId: string;
  contactId: string;
  appointmentId: string;
  startedAt: Date;
}): Promise<string> {
  const boundary = await criarOrigemDeFollowup(pool, params.org, params.contactId);
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, conversation_id, service_boundary, appointment_id, started_at)
     values ($1, $2, $3, $4, 'w1', 'active', now() + interval '1 hour', $5, $6::jsonb, $7, $8)
     returning id`,
    [
      params.org,
      params.pointerId,
      params.versionId,
      params.contactId,
      boundary.conversation_id,
      JSON.stringify(boundary),
      params.appointmentId,
      params.startedAt.toISOString(),
    ],
  );
  return rows[0]!.id;
}

async function seedPipelineEStage(org: string, blocksFollowups: boolean): Promise<{ pipelineId: string; stageId: string }> {
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil do Sinal', 'funil-sinal-' || substr(gen_random_uuid()::text, 1, 8)) returning id`,
    [org],
  );
  const pipelineId = p[0]!.id;
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, blocks_followups)
     values ($1, $2, 'Aguardando sinal', 'aguardando-sinal-' || substr(gen_random_uuid()::text, 1, 8), 100, $3)
     returning id`,
    [org, pipelineId, blocksFollowups],
  );
  return { pipelineId, stageId: s[0]!.id };
}

async function seedLead(org: string, contactId: string, pipelineId: string, stageId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title)
     values ($1, $2, $3, $4, 'Lead do sinal') returning id`,
    [org, pipelineId, stageId, contactId],
  );
  return rows[0]!.id;
}

async function inserirInbound(org: string, contactId: string, conversationId: string, quando: Date): Promise<void> {
  const { rows: sess } = await pool.query<{ channel_session_id: string }>(
    `select channel_session_id from conversations where id = $1`,
    [conversationId],
  );
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body, created_at, sent_at)
     values ($1, $2, $3, $4, 'text', 'inbound', 'aqui está meu comprovante', $5, $5)`,
    [org, conversationId, sess[0]!.channel_session_id, contactId, quando.toISOString()],
  );
}

// Transporte, sem réplica de elegibilidade ou SQL de criação.
const admin = {
  async rpc(name: string, args: Record<string, unknown>) {
    if (name === 'sinal_listar_revisoes') {
      const { rows } = await pool.query('select * from public.sinal_listar_revisoes($1,$2)', [args.p_agora, args.p_limite]);
      return { data: rows, error: null };
    }
    if (name === 'sinal_abrir_revisao') {
      const { rows } = await pool.query('select public.sinal_abrir_revisao($1,$2) as inserted', [args.p_organization_id, args.p_appointment_id]);
      return { data: rows[0]!.inserted, error: null };
    }
    throw new Error(`RPC inesperada: ${name}`);
  },
} as unknown as SupabaseClient;

async function candidata(): Promise<ReservaPendenteDeRevisao> {
  const org = idDeTeste('cafe', ++orgSeq);
  await seedOrg(org);
  const contactId = await seedContact(org);
  const eventTypeId = await seedEventType(org, true);
  const criadaEm = new Date(Date.now() - 61 * 60_000);
  const consultaEm = new Date(Date.now() + 3 * 60 * 60_000);
  const id = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
  return { id, organization_id: org, contact_id: contactId, criada_em: criadaEm.toISOString(), consulta_em: consultaEm.toISOString() };
}

describe("Cadeia real do sinal: reserva → inscrição → T+40 → bloqueios → revisão", () => {
  it("T+40: dentro do prazo, o lembrete PODE sair (nenhum bloqueio do sinal se aplica ainda)", async () => {
    const org = idDeTeste("aaaa", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 40 * 60_000); // T+40: 40min atrás
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000); // consulta bem depois — não capa o prazo
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    const { pointerId, versionId } = await seedFluxoDoSinal(org);
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId, versionId, contactId, appointmentId, startedAt: criadaEm });

    const leitura = await lerFatosDoEnvio(pool, {
      organizationId: org,
      contactId,
      conversationId: (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id,
      enrollmentId,
    });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.fatos.reserva).not.toBeNull();

    const decisao = decidirEnvio(leitura.fatos, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, agora);
    expect(decisao).toEqual({ envia: true });
  });

  it("T+60: prazo vencido — decidirEnvio PARA de mandar (prazo_do_sinal_vencido), lido do banco real", async () => {
    const org = idDeTeste("bbbb", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 61 * 60_000); // T+61: já venceu
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    const { pointerId, versionId } = await seedFluxoDoSinal(org);
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId, versionId, contactId, appointmentId, startedAt: criadaEm });

    const conversationId = (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id;
    const leitura = await lerFatosDoEnvio(pool, { organizationId: org, contactId, conversationId, enrollmentId });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    const decisao = decidirEnvio(leitura.fatos, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, agora);
    expect(decisao).toMatchObject({ envia: false, motivo: "prazo_do_sinal_vencido", invalida: true });
  });

  it('T60 concorrente cria exatamente um aviso; resolução humana não reabre', async () => {
    const r = await candidata();
    const resultados = await Promise.all([abrirItemDeRevisao(admin, r), abrirItemDeRevisao(admin, r)]);
    expect(resultados.sort()).toEqual([false, true]);
    const { rows } = await pool.query(`select kind, ref_kind from agent_inbox_items where organization_id=$1 and ref_id=$2`, [r.organization_id, r.id]);
    expect(rows).toEqual([{ kind: 'sinal_revisao_humana', ref_kind: 'appointment' }]);
    await pool.query(`update agent_inbox_items set status='resolved' where organization_id=$1 and ref_id=$2`, [r.organization_id, r.id]);
    expect(await abrirItemDeRevisao(admin, r)).toBe(false);
    expect((await listarReservasVencidas(admin, new Date(), 500)).some((a) => a.id === r.id)).toBe(false);
  });

  it.each(['cancelled', 'completed', 'no_show'])('revalida status %s depois da seleção', async (status) => {
    const r = await candidata();
    expect((await listarReservasVencidas(admin, new Date(), 500)).some((a) => a.id === r.id)).toBe(true);
    const user = randomUUID();
    await pool.query('insert into auth.users(id,email) values($1,$2)', [user, `${user}@test.invalid`]);
    await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [user,r.organization_id]);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:user,role:'authenticated' })]);
      await client.query("update calendar_appointments set status=$3,starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' where organization_id=$1 and id=$2", [r.organization_id,r.id,status]);
      await client.query('commit');
    } finally { await client.query('rollback'); client.release(); }
    expect(await abrirItemDeRevisao(admin, r)).toBe(false);
    expect((await listarReservasVencidas(admin, new Date(), 500)).some((a) => a.id === r.id)).toBe(false);
  });

  it('revalida anonimização e etapa depois da seleção', async () => {
    const r = await candidata();
    const { stageId, pipelineId } = await seedPipelineEStage(r.organization_id, true);
    await seedLead(r.organization_id, r.contact_id, pipelineId, stageId);
    expect(await abrirItemDeRevisao(admin, r)).toBe(false);
    await pool.query('update crm_stages set blocks_followups=false where organization_id=$1 and id=$2', [r.organization_id, stageId]);
    await pool.query('update contacts set is_anonymized=true, anonymized_at=now() where organization_id=$1 and id=$2', [r.organization_id, r.contact_id]);
    expect(await abrirItemDeRevisao(admin, r)).toBe(false);
  });

  it('501 reservas históricas tratadas não escondem a próxima do limite 500', async () => {
    const r = await candidata();
    await pool.query(`with antigas as (
      insert into calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,contact_id,created_at)
      select organization_id,event_type_id,'Histórico',starts_at,ends_at,contact_id,created_at-interval '1 day'
      from calendar_appointments cross join generate_series(1,501) where id=$1 returning id,organization_id
    ) insert into agent_inbox_items(organization_id,kind,severity,title,ref_kind,ref_id,status)
      select organization_id,'sinal_revisao_humana','warn','Tratado','appointment',id,'resolved' from antigas`, [r.id]);
    expect((await listarReservasVencidas(admin, new Date(), 500)).some((a) => a.id === r.id)).toBe(true);
  });

  it('confirmed continua elegível: status não comprova pagamento', async () => {
    const r = await candidata();
    await pool.query(`update calendar_appointments set status='confirmed' where organization_id=$1 and id=$2`, [r.organization_id, r.id]);
    expect(await abrirItemDeRevisao(admin, r)).toBe(true);
  });

  it('FK excluída cancela inscrição de sinal em vez de liberar envio genérico', async () => {
    const r = await candidata();
    const { pointerId, versionId } = await seedFluxoDoSinal(r.organization_id);
    const enrollmentId = await seedInscricaoDoSinal({ org:r.organization_id, contactId:r.contact_id, pointerId, versionId, appointmentId:r.id, startedAt:new Date() });
    await pool.query('delete from calendar_appointments where organization_id=$1 and id=$2', [r.organization_id, r.id]);
    const { rows } = await pool.query('select appointment_id,status,next_eval_at from followup_enrollments where organization_id=$1 and id=$2', [r.organization_id, enrollmentId]);
    expect(rows).toEqual([{ appointment_id: null, status: 'cancelled', next_eval_at: null }]);
  });

  it("comprovante enviado bloqueia o PRÓXIMO lembrete antes de qualquer pessoa mover o card — lido do banco real (não fatos sintéticos)", async () => {
    const org = idDeTeste("eeee", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 40 * 60_000); // T+40 — ainda dentro do prazo
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    const { pointerId, versionId } = await seedFluxoDoSinal(org); // cancel_on_reply:true
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId, versionId, contactId, appointmentId, startedAt: criadaEm });
    const conversationId = (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id;

    // Card AINDA na etapa antiga — ninguém moveu nada.
    const { stageId, pipelineId } = await seedPipelineEStage(org, false);
    await seedLead(org, contactId, pipelineId, stageId);

    // O comprovante chega como mensagem inbound real, DEPOIS da entrada no
    // fluxo (não há envio anterior registrado em followup_enrollment_events,
    // então a referência de `decidirEnvio` é `enrollment.started_at`).
    const comprovanteEm = new Date(agora.getTime() - 5 * 60_000); // 5min atrás — depois do started_at
    await inserirInbound(org, contactId, conversationId, comprovanteEm);

    const leitura = await lerFatosDoEnvio(pool, { organizationId: org, contactId, conversationId, enrollmentId });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.fatos.ultima_recebida_em).not.toBeNull();

    const decisao = decidirEnvio(leitura.fatos, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, agora);
    expect(decisao).toMatchObject({ envia: false, motivo: "resposta_do_contato", invalida: true });
  });

  it("o banco impede duas sequências vivas do mesmo contato, mesmo em pointers diferentes", async () => {
    const org = idDeTeste("ffff", ++orgSeq);
    const config: ConfigDosBloqueios = { ...CONFIG_SEM_BLOQUEIOS_OPCIONAIS, uma_sequencia_por_contato: true };
    await seedOrg(org, { followups: { bloqueios: config } });
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 10 * 60_000);
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });

    // D1/D3/D7: OUTRO pointer, sem appointment_id, iniciado ANTES do sinal.
    const { pointerId: pointerD1, versionId: versionD1 } = await seedFluxoDoSinal(org);
    const inicioD1 = new Date(agora.getTime() - 60 * 60_000);
    const boundaryD1 = await criarOrigemDeFollowup(pool, org, contactId);
    await pool.query(
      `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, conversation_id, service_boundary, started_at)
       values ($1, $2, $3, $4, 'w1', 'active', now() + interval '1 hour', $5, $6::jsonb, $7)`,
      [org, pointerD1, versionD1, contactId, boundaryD1.conversation_id, JSON.stringify(boundaryD1), inicioD1.toISOString()],
    );

    // Fluxo do sinal: pointer DIFERENTE, iniciado DEPOIS do D1.
    const { pointerId: pointerSinal, versionId: versionSinal } = await seedFluxoDoSinal(org);
    await expect(seedInscricaoDoSinal({ org, pointerId: pointerSinal, versionId: versionSinal, contactId, appointmentId, startedAt: agora }))
      .rejects.toMatchObject({ code: "23505", constraint: "idx_followup_enrollments_one_live" });
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from followup_enrollments where organization_id = $1 and contact_id = $2 and status = 'active'`,
      [org, contactId],
    );
    expect(rows[0]!.n).toBe("1");
  });
});


describe('RPCs do sinal: isolamento e ACL', () => {
  it('não abre aviso de reserva de outra organização', async () => {
    const a = await candidata(); const b = await candidata();
    expect(await abrirItemDeRevisao(admin, { ...a, organization_id:b.organization_id })).toBe(false);
  });
  it.each(['sinal_listar_revisoes(timestamp with time zone,integer)', 'sinal_abrir_revisao(uuid,uuid)', 'sinal_reservas_elegiveis(timestamp with time zone)'])('RPC privada: %s', async (fn) => {
    const { rows } = await pool.query(`select has_function_privilege('anon',$1,'execute') as anon,
      has_function_privilege('authenticated',$1,'execute') as authenticated,
      has_function_privilege('service_role',$1,'execute') as service`, [`public.${fn}`]);
    expect(rows).toEqual([{ anon:false, authenticated:false, service:true }]);
  });
});

it('mutex serializa T60 com reserva→FK de contato da recuperação, sem deadlock', async () => {
  const r = await candidata();
  const { pointerId, versionId } = await seedFluxoDoSinal(r.organization_id);
  const boundary = await criarOrigemDeFollowup(pool, r.organization_id, r.contact_id);
  const writer = await pool.connect();
  let abertura: Promise<boolean> | undefined;
  try {
    await writer.query('begin');
    await writer.query("set local lock_timeout = '3s'");
    const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await writer.query('select public.fn_service_lock($1,$2)', [r.organization_id,r.contact_id]);
    // Ordem usada por fn_appointment_recover: mutex, reserva e INSERT com FK
    // do contato. A fixture exercita a FK real sem duplicar a política de recuperação.
    await writer.query('select id from calendar_appointments where organization_id=$1 and id=$2 for update', [r.organization_id,r.id]);
    abertura = abrirItemDeRevisao(admin,r);
    void abertura.catch(() => undefined);
    await expect.poll(async () => {
      const { rows } = await pool.query<{ waiting: boolean }>(`select exists(
        select 1 from pg_locks l where l.locktype='advisory' and not l.granted
          and $1::integer = any(pg_blocking_pids(l.pid))) as waiting`, [pid]);
      return rows[0]!.waiting;
    }, { timeout: 2000 }).toBe(true);
    await writer.query(`insert into followup_enrollments
      (organization_id,pointer_id,version_id,contact_id,current_node_id,status,next_eval_at,conversation_id,service_boundary,appointment_id)
      values($1,$2,$3,$4,'w1','active',now()+interval '1 hour',$5,$6::jsonb,$7)`,
      [r.organization_id,pointerId,versionId,r.contact_id,boundary.conversation_id,JSON.stringify(boundary),r.id]);
    await writer.query('commit');
    expect(await abertura).toBe(true);
    expect(await abrirItemDeRevisao(admin,r)).toBe(false);
  } finally {
    await writer.query('rollback');
    writer.release();
    await abertura?.catch(() => undefined);
  }
});
