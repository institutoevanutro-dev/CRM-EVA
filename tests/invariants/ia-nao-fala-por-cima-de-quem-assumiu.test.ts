import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as SplitMessage from "@/lib/agent-engine/agent/split-message";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as Claim from "@/lib/agent-engine/queue/claim";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as WahaAdapter from "@/lib/agent-engine/edge/channel/waha-adapter";

/**
 * A IA NÃO FALA POR CIMA DE QUEM ASSUMIU DURANTE O TURNO.
 *
 * Medido em produção (08 e 09/10/2026): o cliente escreveu, o turno começou, uma
 * pessoa respondeu pelo celular (a ingestão gravou `bot_silenced_until`) e a IA
 * enviou 2 a 4 s depois dela. O silêncio só era lido no começo do turno.
 *
 * Quem confere agora é o sink (`pessoaAssumiuAConversa`,
 * lib/agent-engine/edge/crm/send-message.ts), a cada BOLHA. Por isso o canal
 * aqui é o REAL do motor (`WahaChannelAdapter` -> ledger -> `sendMessageHandler`),
 * e não o canal de captura dos vizinhos: um canal falso passaria por cima
 * exatamente do que está sob teste. Sem WAHA configurado o handler grava a
 * mensagem como `queued`, sem rede: "saiu" aqui é linha outbound em `messages`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 6,
});

const ORG = "eec20000-0000-4000-8000-000000000001";
const CONTACT = "eec20000-0000-4000-8000-000000000002";
const SESSION = "eec20000-0000-4000-8000-000000000003";
const CONV = "eec20000-0000-4000-8000-000000000004";
const MSG = "eec20000-0000-4000-8000-000000000005";

// O handler audita pelo admin client: aqui ele é o mesmo Postgres.
const adminFake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFake.client }));

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  sendInBubbles: typeof SplitMessage.sendInBubbles;
  queue: typeof Queue;
  claimOfJob: typeof Claim.claimOfJob;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  WahaChannelAdapter: typeof WahaAdapter.WahaChannelAdapter;
};
let m: Modules;
let canal: WahaAdapter.WahaChannelAdapter;
let resultadosVistos: unknown[] = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});
const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** O que a ingestão grava quando alguém responde pelo celular (`pausarIaPorAtendimentoManual`). */
async function pessoaRespondePeloCelular(): Promise<void> {
  await pool.query(
    `update conversations set bot_silenced_until = now() + interval '5 minutes'
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
}

async function mensagensQueSairam(): Promise<string[]> {
  const { rows } = await pool.query<{ body: string }>(
    `select body from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
      order by created_at, id`,
    [ORG, CONV],
  );
  return rows.map((r) => r.body);
}

/**
 * Modelo fake: na 1ª chamada pede `send_message`; depois fecha. `enquantoPensa`
 * roda DENTRO da 1ª chamada, isto é, depois das guardas do começo do turno e
 * antes do envio: os 10 a 40 s de modelo do caso medido.
 */
function modelo(enquantoPensa: () => Promise<void>) {
  let chamadas = 0;
  return async (opts: { prompt?: unknown }) => {
    for (const msg of (opts.prompt ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") resultadosVistos.push(parte.output ?? parte);
      }
    }
    chamadas += 1;
    if (chamadas === 1) {
      await enquantoPensa();
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: "Temos horário na quinta às 15h, pode ser?" }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: CHECKPOINT }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

async function jobReivindicado(): Promise<Queue.JobRow> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 3,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "assumiu", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  return claimed!;
}

/** O turno inteiro, pelo handler real e pelo canal real. Devolve o status final do job. */
async function rodaTurno(enquantoPensa: () => Promise<void>): Promise<string> {
  const job = await jobReivindicado();
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: pgComoSupabase(pool) } as never,
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 6,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(modelo(enquantoPensa) as never),
    channel: () => canal,
    // Terça, 15h BRT: dentro da janela anti-ban.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  try {
    await handler(job, pool, { workerId: "assumiu" });
    await m.queue.completeJob(pool, job.id, "assumiu");
  } catch (err) {
    await m.queue.failJob(pool, job.id, "assumiu", err);
  }
  const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [job.id]);
  return rows[0]!.status;
}

/** As bolhas de UM envio, como o `send_message` as manda: `sendInBubbles` + canal, um `seq` por bolha. */
async function mandaEmBolhas(corpo: string, entreBolhas: () => Promise<void>) {
  const job = await jobReivindicado();
  let seq = 0;
  return m.sendInBubbles(corpo, {
    enabled: true,
    maxChars: 600,
    sleep: entreBolhas,
    jitter: () => 0,
    send: (bolha) => {
      seq += 1;
      return canal.send({
        tenantId: ORG,
        leadId: CONTACT,
        jobId: job.id,
        jobClaim: m.claimOfJob(job),
        seq,
        conversationId: CONV,
        body: bolha,
      });
    },
  });
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    sendInBubbles: (await import("@/lib/agent-engine/agent/split-message")).sendInBubbles,
    queue: await import("@/lib/agent-engine/queue/queue"),
    claimOfJob: (await import("@/lib/agent-engine/queue/claim")).claimOfJob,
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    WahaChannelAdapter: (await import("@/lib/agent-engine/edge/channel/waha-adapter")).WahaChannelAdapter,
  };
  adminFake.client = pgComoSupabase(pool);
  canal = new m.WahaChannelAdapter(pool, { supabase: pgComoSupabase(pool) } as never);

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'quem-assumiu','Quem Assumiu','Quem Assumiu') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Cliente de teste','+5511900000966') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'quem-assumiu-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Tem horário essa semana?','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  resultadosVistos = [];
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from pacing_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("update conversations set bot_silenced_until = null where id = $1", [CONV]);
  await pool.query("update contacts set force_human = false where id = $1", [CONTACT]);
});

// Job deste arquivo que ficasse `running` travaria o `claimJobs` dos arquivos seguintes.
afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.end();
});

describe("a IA não fala por cima de quem assumiu durante o turno", () => {
  it("controle: sem pessoa na conversa, a resposta sai como sempre", async () => {
    await rodaTurno(async () => {});
    expect(await mensagensQueSairam()).toEqual(["Temos horário na quinta às 15h, pode ser?"]);
    expect(JSON.stringify(resultadosVistos)).not.toMatch(/pessoa_no_comando/);
  });

  it("a pessoa respondeu enquanto o modelo pensava: nada sai, nada fica para re-tentar", async () => {
    const status = await rodaTurno(pessoaRespondePeloCelular);

    expect(await mensagensQueSairam()).toEqual([]);
    // O modelo ouviu que não foi enviada (é o que o checkpoint do turno lê).
    expect(JSON.stringify(resultadosVistos)).toMatch(/pessoa_no_comando/);
    // Sem intenção no ledger e com o job fechado: não há retry para bater no mesmo muro.
    const { rows } = await pool.query("select 1 from send_ledger where organization_id = $1", [ORG]);
    expect(rows).toEqual([]);
    expect(status).toBe("done");
  });

  it("controle: sem pessoa, as três bolhas saem", async () => {
    const fim = await mandaEmBolhas("Oi, Ana!\n\nTemos quinta às 15h.\n\nPode ser?", async () => {});
    expect(await mensagensQueSairam()).toEqual(["Oi, Ana!", "Temos quinta às 15h.", "Pode ser?"]);
    expect(fim.kind).not.toBe("human_took_over");
  });

  it("a pessoa respondeu depois da 1ª bolha: a 2ª e a 3ª não saem", async () => {
    let pausas = 0;
    const fim = await mandaEmBolhas("Oi, Ana!\n\nTemos quinta às 15h.\n\nPode ser?", async () => {
      pausas += 1;
      if (pausas === 1) await pessoaRespondePeloCelular();
    });

    expect(await mensagensQueSairam()).toEqual(["Oi, Ana!"]);
    expect(fim).toEqual({ kind: "human_took_over", motivo: "conversa_silenciada" });
    // Parou na 2ª: a pausa antes da 3ª nem aconteceu.
    expect(pausas).toBe(1);
  });

  it("contato travado para atendimento humano no meio do turno também segura a bolha", async () => {
    await pool.query("update contacts set force_human = true where id = $1", [CONTACT]);
    const fim = await mandaEmBolhas("Oi, Ana!", async () => {});
    expect(fim).toEqual({ kind: "human_took_over", motivo: "force_human" });
    expect(await mensagensQueSairam()).toEqual([]);
  });

  it("silêncio que já venceu não segura nada", async () => {
    await pool.query(
      "update conversations set bot_silenced_until = now() - interval '1 second' where id = $1",
      [CONV],
    );
    await mandaEmBolhas("Oi, Ana!", async () => {});
    expect(await mensagensQueSairam()).toEqual(["Oi, Ana!"]);
  });
});
