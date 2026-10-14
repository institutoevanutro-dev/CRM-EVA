/**
 * ASSUMIR A CONVERSA INTERROMPE O TURNO DA IA, NO BANCO (migration 0361).
 *
 * Porte de melgarafael/DeskcommCRM #2541 (@ozzure; `assumir-interrompe-turno` e
 * `revogacao-canonica-e-descarte-worker` lá), na forma do fork: o gatilho de
 * `conversation_assignment_events` encerra os turnos `inbound_turn` e
 * `case_reply_turn` da conversa e grava o fato `conversation.autonomous_turn_revoked`
 * de cada job revogado; o `followup_turn` em execução recebe só o fato e o worker
 * o encerra (`encerrarTurnoRevogado`).
 *
 * Roda no Postgres descartável de `scripts/test-db.sh`, com o baseline inteiro.
 * Não mede modelo, tela nem WAHA.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guardServiceEffect, requireCurrentAutonomousTurn, withServiceJob } from "@/lib/atendimento/fronteira-server";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { encerrarTurnoRevogado } from "@/lib/atendimento/turno-revogado";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { sql } from "./psql-transporte";

const ORG = "03610001-0000-4000-8000-000000000001";
const CONTACT = "03610001-0000-4000-8000-000000000002";
const SESSION = "03610001-0000-4000-8000-000000000003";
const CONVERSATION = "03610001-0000-4000-8000-000000000004";
const OWNER = "03610001-0000-4000-8000-000000000005";
// A segunda organização: mesma forma, nada compartilhado.
const ORG_B = "03610002-0000-4000-8000-000000000001";
const CONTACT_B = "03610002-0000-4000-8000-000000000002";
const SESSION_B = "03610002-0000-4000-8000-000000000003";
const CONVERSATION_B = "03610002-0000-4000-8000-000000000004";
const OWNER_B = "03610002-0000-4000-8000-000000000005";
const OUTRA_CONVERSA = "03610001-0000-4000-8000-000000000099";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

function valor(query: string): number {
  return Number(sql(query).trim().split("\n").at(-1));
}
function atribuir(motivo = "claim", dono: string | null = OWNER, org = ORG, conversa = CONVERSATION) {
  sql(
    `select public.fn_conversation_assign('${org}', '${conversa}', ${dono ? `'${dono}'` : "null"}, '${motivo}', null, false);`,
  );
}
function semear(kind: string, status = "running", conversa = CONVERSATION, org = ORG, contato = CONTACT) {
  // A fronteira inteira, como a do turno real: `withServiceJob` a confere.
  sql(`insert into public.job_queue (organization_id, contact_id, kind, status, payload, locked_by, locked_at)
    select '${org}', '${contato}', '${kind}', '${status}',
      jsonb_build_object('service_boundary', jsonb_build_object('organization_id', '${org}', 'contact_id', '${contato}',
        'conversation_id', '${conversa}', 'service_revision', coalesce(c.service_revision, 0), 'demanda_id', null, 'demanda_revision', null)),
      ${status === "running" ? "'worker-tomada'" : "null"}, ${status === "running" ? "clock_timestamp()" : "null"}
    from (select 1) um left join public.conversations c on c.id = '${conversa}';`);
}
async function emExecucao(org = ORG): Promise<JobRow> {
  return (
    await pool.query<JobRow>(
      "select *, locked_at::text as claim_acquired_at from job_queue where organization_id=$1 and status='running'",
      [org],
    )
  ).rows[0]!;
}
const revogados = (org = ORG) =>
  valor(
    `select count(*) from public.event_log where organization_id='${org}' and event_type='conversation.autonomous_turn_revoked';`,
  );

beforeAll(() => {
  sql(`insert into auth.users (id,email) values ('${OWNER}','tomada-0361@invariant.test'),('${OWNER_B}','tomada-0361-b@invariant.test') on conflict do nothing;
    insert into public.organizations (id,slug,legal_name,display_name) values
      ('${ORG}','tomada-0361','Tomada','Tomada'),('${ORG_B}','tomada-0361-b','Tomada B','Tomada B') on conflict do nothing;
    insert into public.user_organizations (user_id,organization_id,role,accepted_at) values
      ('${OWNER}','${ORG}','agent',now()),('${OWNER_B}','${ORG_B}','agent',now()) on conflict do nothing;
    insert into public.contacts (id,organization_id,display_name) values
      ('${CONTACT}','${ORG}','Cliente fictício'),('${CONTACT_B}','${ORG_B}','Cliente fictício B') on conflict do nothing;
    insert into public.channel_sessions (id,organization_id,waha_session_name,webhook_secret_encrypted) values
      ('${SESSION}','${ORG}','tomada-0361','\\x00'::bytea),('${SESSION_B}','${ORG_B}','tomada-0361-b','\\x00'::bytea) on conflict do nothing;
    insert into public.conversations (id,organization_id,contact_id,channel_session_id,status) values
      ('${CONVERSATION}','${ORG}','${CONTACT}','${SESSION}','open'),
      ('${CONVERSATION_B}','${ORG_B}','${CONTACT_B}','${SESSION_B}','open') on conflict do nothing;`);
});
beforeEach(() => {
  sql(`delete from public.followup_enrollments where organization_id in ('${ORG}','${ORG_B}');
    delete from public.job_queue where organization_id in ('${ORG}','${ORG_B}');
    delete from public.event_log where organization_id in ('${ORG}','${ORG_B}') and event_type='conversation.autonomous_turn_revoked';
    update public.conversations set assigned_to_user_id=null, assignee_kind=null, bot_silenced_until=null, last_handoff_at=null, status='open'
     where id in ('${CONVERSATION}','${CONVERSATION_B}');`);
});

describe("a tomada humana revoga o turno da IA daquela conversa", () => {
  it.each(["claim", "transfer"])(
    "%s encerra inbound/case na fila e rodando, com o motivo; devolver não ressuscita",
    (motivo) => {
      for (const kind of ["inbound_turn", "case_reply_turn"])
        for (const status of ["pending", "running"]) {
          sql(`delete from public.job_queue where organization_id='${ORG}';
               delete from public.event_log where organization_id='${ORG}' and event_type='conversation.autonomous_turn_revoked';`);
          semear(kind, status);
          atribuir(motivo);
          atribuir("release", null);
          expect(
            valor(
              `select count(*) from public.job_queue where organization_id='${ORG}' and status='failed' and locked_at is null and locked_by is null and last_error='conversation_command_taken';`,
            ),
            `${kind}/${status}`,
          ).toBe(1);
          expect(
            valor(
              `select count(*) from public.event_log where organization_id='${ORG}' and event_type='conversation.autonomous_turn_revoked'
                 and status='done' and payload->>'motivo'='${motivo}' and payload->>'kind'='${kind}' and payload->>'status_anterior'='${status}'
                 and payload->>'conversation_id'='${CONVERSATION}';`,
            ),
          ).toBe(1);
          // O lease perdido não conclui: o completeJob do worker não acha a linha.
          expect(
            valor(
              `with c as (update public.job_queue set status='done' where organization_id='${ORG}' and status='running' and locked_by='worker-tomada' returning id) select count(*) from c;`,
            ),
          ).toBe(0);
        }
    },
  );

  it("preserva ordens de pessoa, follow-up agendado e a conversa vizinha", () => {
    for (const kind of ["transactional_delivery", "approved_reply", "operator_turn"]) semear(kind, "pending");
    semear("followup_turn", "pending");
    semear("inbound_turn");
    semear("inbound_turn", "pending", OUTRA_CONVERSA);
    atribuir();
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='failed';`)).toBe(1);
    expect(
      valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status in ('pending','running');`),
    ).toBe(5);
    expect(revogados()).toBe(1);
  });

  it.each(["transactional_delivery", "approved_reply", "operator_turn"])("preserva %s em execução", (kind) => {
    semear(kind);
    atribuir();
    expect(
      valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='running' and locked_by='worker-tomada';`),
    ).toBe(1);
    expect(revogados()).toBe(0);
  });

  it.each(["routing", "handoff"])("%s não interrompe o turno", (motivo) => {
    semear("inbound_turn");
    semear("inbound_turn", "pending");
    atribuir(motivo);
    expect(
      valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status in ('pending','running');`),
    ).toBe(2);
    expect(revogados()).toBe(0);
  });

  it("outra organização: nada muda lá, e a tomada lá não toca aqui", () => {
    semear("inbound_turn");
    semear("inbound_turn", "pending");
    semear("inbound_turn", "running", CONVERSATION_B, ORG_B, CONTACT_B);
    semear("case_reply_turn", "pending", CONVERSATION_B, ORG_B, CONTACT_B);
    atribuir("claim", OWNER);
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='failed';`)).toBe(2);
    expect(
      valor(`select count(*) from public.job_queue where organization_id='${ORG_B}' and status in ('pending','running');`),
    ).toBe(2);
    expect(revogados(ORG_B)).toBe(0);
    atribuir("claim", OWNER_B, ORG_B, CONVERSATION_B);
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG_B}' and status='failed';`)).toBe(2);
    expect(revogados(ORG)).toBe(2);
    expect(revogados(ORG_B)).toBe(2);
  });

  it("job cuja fronteira aponta outra organização não é revogado; evento sem dono real também não", () => {
    semear("inbound_turn");
    sql(`insert into public.conversation_assignment_events (organization_id,conversation_id,to_user_id,reason)
      values ('${ORG}','${CONVERSATION}','${OWNER}','claim');`);
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`)).toBe(1);
    sql(
      `update public.job_queue set payload=jsonb_set(payload,'{service_boundary,organization_id}','"${ORG_B}"') where organization_id='${ORG}';`,
    );
    atribuir();
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`)).toBe(1);
    expect(revogados()).toBe(0);
  });

  it("a tomada desfeita (rollback) não deixa cancelamento nem fato", () => {
    semear("inbound_turn");
    sql(`begin; select public.fn_conversation_assign('${ORG}','${CONVERSATION}','${OWNER}','claim',null,false); rollback;`);
    expect(
      valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='running' and locked_by='worker-tomada';`),
    ).toBe(1);
    expect(revogados()).toBe(0);
  });

  it("a sessão de quem clica assume com follow-up rodando, sem esbarrar na proteção do follow-up", () => {
    semear("followup_turn");
    sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
      select public.fn_conversation_assign('${ORG}','${CONVERSATION}','${OWNER}','claim',null,false);`);
    // A linha do follow-up não é tocada; o fato é que tira o comando.
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`)).toBe(1);
    expect(revogados()).toBe(1);
  });

  it("login não fabrica a revogação por emit_event, fn_log_event ou escrita direta", async () => {
    semear("followup_turn");
    const job = await emExecucao();
    const comandos = [
      {
        text: "select emit_event('conversation.autonomous_turn_revoked','job',$1,$2,'{}',$3)",
        values: [job.id, JSON.stringify({ conversation_id: CONVERSATION }), ORG],
      },
      {
        text: "select fn_log_event($1,'conversation.autonomous_turn_revoked',$2)",
        values: [ORG, JSON.stringify({ conversation_id: CONVERSATION, conversation_id_job: job.id })],
      },
      {
        text: "insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,status) values($1,'conversation.autonomous_turn_revoked','job',$2,$3,'done')",
        values: [ORG, job.id, JSON.stringify({ conversation_id: CONVERSATION })],
      },
    ];
    for (const comando of comandos) {
      const tx = await pool.connect();
      try {
        await tx.query("begin");
        await tx.query("set local role authenticated");
        await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: OWNER })]);
        await expect(tx.query(comando), comando.text).rejects.toMatchObject({ code: "42501" });
      } finally {
        await tx.query("rollback");
        tx.release();
      }
    }
    expect(revogados()).toBe(0);
    await expect(requireCurrentAutonomousTurn(pool, job)).resolves.toBeUndefined();
  });

  it.each(["anon", "authenticated"])("%s não consulta o predicado do servidor", async (papel) => {
    semear("inbound_turn");
    const job = await emExecucao();
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      await tx.query(`set local role ${papel}`);
      await expect(tx.query("select fn_autonomous_turn_revoked($1,$2)", [ORG, job.id])).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await tx.query("rollback");
      tx.release();
    }
  });

  it("o fato só vale com a mesma organização, a conversa do job, a entidade job e estado done", async () => {
    semear("followup_turn");
    const job = await emExecucao();
    for (const [org, conversa, entidade, status] of [
      [ORG_B, CONVERSATION, "job", "done"],
      [ORG, OUTRA_CONVERSA, "job", "done"],
      [ORG, CONVERSATION, "conversation", "done"],
      [ORG, CONVERSATION, "job", "pending"],
    ]) {
      await pool.query(
        "insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,status) values($1,'conversation.autonomous_turn_revoked',$2,$3,jsonb_build_object('conversation_id',$4::text),$5)",
        [org, entidade, job.id, conversa, status],
      );
      expect((await pool.query("select fn_autonomous_turn_revoked($1,$2) v", [ORG, job.id])).rows[0]!.v).toBe(false);
      await expect(requireCurrentAutonomousTurn(pool, job)).resolves.toBeUndefined();
    }
    atribuir();
    expect((await pool.query("select fn_autonomous_turn_revoked($1,$2) v", [ORG, job.id])).rows[0]!.v).toBe(true);
    expect((await pool.query("select fn_autonomous_turn_revoked($1,$2) v", [ORG_B, job.id])).rows[0]!.v).toBe(false);
  });
});

describe("o servidor recusa a escrita da IA depois da tomada", () => {
  it.each([false, true])(
    "tomada durante o turno (devolver=%s): a escrita seguinte é recusada e o worker encerra sem incidente",
    async (devolver) => {
      semear("inbound_turn");
      const job = await emExecucao();
      const log = { warn: vi.fn() };
      let escritas = 0;
      let pego: unknown;
      try {
        await withServiceJob(pool, job, async () => {
          await guardServiceEffect(); // primeira escrita: ainda no comando
          escritas++;
          atribuir();
          if (devolver) atribuir("release", null);
          await guardServiceEffect(); // a seguinte, no mesmo turno
          escritas++;
        });
      } catch (erro) {
        pego = erro;
      }
      expect(pego).toBeInstanceOf(StaleServiceBoundaryError);
      expect(escritas).toBe(1);
      expect(await encerrarTurnoRevogado(pool, job, "worker-tomada", pego, log)).toBe(true);
      expect(log.warn).toHaveBeenCalledWith("turno da IA interrompido: uma pessoa assumiu a conversa", {
        job_id: job.id,
        organization_id: ORG,
        kind: "inbound_turn",
      });
      // Um retry do mesmo job nem começa.
      await expect(withServiceJob(pool, job, async () => undefined)).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    },
  );

  it("sem tomada nada muda: o turno escreve e o encerramento de revogado não age", async () => {
    semear("inbound_turn");
    const job = await emExecucao();
    let escritas = 0;
    await withServiceJob(pool, job, async () => {
      await guardServiceEffect();
      escritas++;
      atribuir("routing");
      await guardServiceEffect();
      escritas++;
    });
    expect(escritas).toBe(2);
    expect(await encerrarTurnoRevogado(pool, job, "worker-tomada", new Error("x"), { warn: vi.fn() })).toBe(false);
    expect(valor(`select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`)).toBe(1);
  });

  it.each(["paused_handoff", "active", "cancelled"])(
    "follow-up revogado: o worker encerra o turno e deixa turn_discarded na inscrição %s viva",
    async (status) => {
      const versao = (
        await pool.query("insert into followup_flow_versions(organization_id,graph) values($1,'{}') returning id", [ORG])
      ).rows[0]!.id;
      const ponteiro = (
        await pool.query(
          "insert into followup_flow_pointers(organization_id,name,handoff_policy,active_version_id) values($1,$2,'pause',$3) returning id",
          [ORG, `tomada-${status}`, versao],
        )
      ).rows[0]!.id;
      const inscricao = (
        await pool.query(
          `insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,next_eval_at)
           values($1,$2,$3,$4,$5,'enviar',$6::text,case when $6::text='active' then now()+interval '1 hour' end) returning id`,
          [ORG, ponteiro, versao, CONTACT, CONVERSATION, status],
        )
      ).rows[0]!.id;
      await pool.query(
        `insert into job_queue(organization_id,contact_id,kind,status,locked_by,locked_at,payload)
         values($1::uuid,$2::uuid,'followup_turn','running','worker-tomada',clock_timestamp(),
           jsonb_build_object('service_boundary',jsonb_build_object('organization_id',$1::text,'contact_id',$2::text,'conversation_id',$3::text),
             'purpose','send_message','followup_enrollment_id',$4::text,'node_id','enviar','source_step_key','enviar:0'))`,
        [ORG, CONTACT, CONVERSATION, inscricao],
      );
      const job = await emExecucao();
      await expect(requireCurrentAutonomousTurn(pool, job)).resolves.toBeUndefined();
      atribuir();
      atribuir("release", null);
      await expect(requireCurrentAutonomousTurn(pool, job)).rejects.toBeInstanceOf(StaleServiceBoundaryError);
      const log = { warn: vi.fn() };
      expect(await encerrarTurnoRevogado(pool, job, "worker-tomada", new StaleServiceBoundaryError(), log)).toBe(true);
      // Repetir é seguro: o lease já não é deste worker e nada novo é escrito.
      expect(await encerrarTurnoRevogado(pool, job, "worker-tomada", new StaleServiceBoundaryError(), log)).toBe(true);
      expect(
        (await pool.query("select status,last_error,locked_by from job_queue where id=$1", [job.id])).rows[0],
      ).toEqual({ status: "failed", last_error: "conversation_command_taken", locked_by: null });
      expect((await pool.query("select status from followup_enrollments where id=$1", [inscricao])).rows[0]!.status).toBe(
        status,
      );
      expect(
        valor(
          `select count(*) from followup_enrollment_events where enrollment_id='${inscricao}' and event_type='turn_discarded'
             and idempotency_key='enviar:0:descartado' and payload->>'motivo'='conversation_command_taken';`,
        ),
      ).toBe(status === "cancelled" ? 0 : 1);
    },
  );

  it("follow-up cujo lease já mudou: o encerramento não toca o ciclo novo", async () => {
    semear("followup_turn");
    const job = await emExecucao();
    atribuir();
    await pool.query("update job_queue set locked_by='outro-worker',locked_at=clock_timestamp() where id=$1", [job.id]);
    const antes = (await pool.query("select status,locked_by,locked_at::text from job_queue where id=$1", [job.id])).rows[0];
    expect(await encerrarTurnoRevogado(pool, job, "worker-tomada", new StaleServiceBoundaryError(), { warn: vi.fn() })).toBe(
      true,
    );
    expect((await pool.query("select status,locked_by,locked_at::text from job_queue where id=$1", [job.id])).rows[0]).toEqual(
      antes,
    );
  });
});
