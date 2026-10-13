import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Drain from "@/lib/agent-engine/edge/crm/drain";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as WahaAdapter from "@/lib/agent-engine/edge/channel/waha-adapter";

/**
 * A CARONA NÃO ENGOLE A RESPOSTA.
 *
 * O drain junta a rajada: mensagem que chega com um turno PENDENTE da mesma
 * conversa entra de carona nele, em vez de ganhar turno próprio. Só que
 * "pendente com `run_after` no futuro" também é o estado do job que JÁ ENVIOU
 * parte da resposta, falhou e espera o retry (10 a 120 s). O retry reusa as
 * chaves `(job, seq)` do `send_ledger`: a primeira bolha do que ele escrever
 * volta como `already_sent` e não sai. Se a resposta à mensagem nova couber numa
 * bolha, o paciente não recebe nada, o job fecha `done` e ninguém é avisado.
 *
 * Harness de `agent-transfer-to-subject-turn.test.ts`: handler real, drain real,
 * Postgres real e o canal REAL do motor (`WahaChannelAdapter` -> ledger ->
 * handler). Sem WAHA configurado a mensagem fica `queued`; `canalAceita` faz o
 * que o WhatsApp faria (mensagem `sent`, ledger `accepted`). "O que o paciente
 * recebeu" é a lista de outbound em `messages`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set: rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 6,
});

const id = (n: number) => `eed40000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const CONTACT = id(2);
const SESSION = id(3);
const CONV = id(4);

const adminFake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFake.client }));

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  drainTick: typeof Drain.drainTick;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;
let canal: WahaAdapter.WahaChannelAdapter;
/** Chamadas de modelo COM ferramentas (o fechamento do turno não conta). */
let chamadasDoModelo = 0;
let resultadosVistos: unknown[] = [];

/** Teto da resposta obsoleta e janela de coalescência: os padrões de produção. */
const TETO = 120_000;
const DEBOUNCE = 8_000;

const A1 = "Temos horário na quinta às 15h.";
const A2 = "Quer que eu reserve para você?";
const PERGUNTA_B = "E quanto custa a consulta?";
const RESPOSTA_B = "A consulta custa 200 reais.";

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

/** Um passo do modelo: enviar um texto, ou cair no meio do turno. */
type Passo = string | "falha";
const FALHA = "falha" as const;

/** Modelo fake com roteiro. O estado vive no closure: sobrevive ao retry do job. */
function modelo(roteiro: Passo[]) {
  let pos = 0;
  let n = 0;
  return async (opts: { prompt?: unknown; tools?: Array<{ name: string }> }) => {
    for (const msg of (opts.prompt ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") resultadosVistos.push(parte.output ?? parte);
      }
    }
    const fecha = {
      content: [{ type: "text" as const, text: CHECKPOINT }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
    // Sem tools é a chamada de fechamento (checkpoint): não gasta o roteiro.
    if ((opts.tools ?? []).length === 0) return fecha;
    chamadasDoModelo += 1;
    const proximo = roteiro[pos];
    if (proximo === undefined) return fecha;
    pos += 1;
    if (proximo === FALHA) throw new Error("modelo caiu no meio do turno");
    n += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${n}`,
          toolName: "send_message",
          input: JSON.stringify({ body: proximo }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function handler(roteiro: Passo[]) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: pgComoSupabase(pool) } as never,
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 6,
      queuedRetryDelayMs: 1000,
      respostaObsoletaTetoMs: TETO,
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
    registry: m.createFakeRegistry(modelo(roteiro) as never),
    channel: () => canal,
    // Terça, 15h BRT: dentro da janela anti-ban.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  } as InboundTurn.InboundTurnDeps);
}

async function novaInbound(texto: string): Promise<string> {
  const msg = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device', now())`,
    [msg, ORG, CONV, SESSION, CONTACT, texto],
  );
  return msg;
}

/**
 * O caminho de produção da mensagem até um turno: a ingestão emite
 * `ai_agent.dispatch_requested` e o drain decide: carona, job próprio ou nada.
 * Devolve o job criado PARA ESTA mensagem, se houver.
 *
 * O portão de capacidade do drain só enfileira com agente publicado no número.
 * O agente sai logo depois: os turnos seguem pelo caminho genérico, e é o drain,
 * não o agente, que está sob teste.
 */
async function chegaEDrena(texto: string): Promise<string | null> {
  const msg = await novaInbound(texto);
  const agente = crypto.randomUUID();
  const versao = crypto.randomUUID();
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agente, ORG, `Agente da carona ${agente}`],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [versao, ORG, agente, SESSION],
  );
  await pool.query("update ai_agents set published_version_id = $1 where id = $2", [versao, agente]);
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid, $3::jsonb, 'pending')`,
    [
      ORG,
      msg,
      JSON.stringify({
        conversation_id: CONV,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        inbound_message_id: msg,
      }),
    ],
  );
  try {
    await m.drainTick(
      pool,
      { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: DEBOUNCE, reapTimeoutMs: 300_000 },
      m.createLogger(),
    );
  } finally {
    await pool.query("delete from ai_agents where id = $1", [agente]);
  }
  const { rows } = await pool.query<{ id: string }>(
    `select id from job_queue
      where organization_id = $1 and kind = 'inbound_turn' and payload->>'inbound_message_id' = $2`,
    [ORG, msg],
  );
  return rows[0]?.id ?? null;
}

/** Reivindica o job e roda o handler real. Devolve o erro (o job volta à fila) ou null (`done`). */
async function tenta(jobId: string, h: ReturnType<typeof handler>): Promise<Error | null> {
  // O job espera o debounce ou o retry: aqui ele roda já. Os OUTROS seguem esperando.
  await pool.query("update job_queue set run_after = now() where id = $1 and status = 'pending'", [jobId]);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "carona", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  try {
    await h(claimed!, pool, { workerId: "carona" });
    await m.queue.completeJob(pool, claimed!.id, "carona");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "carona", err);
    return err as Error;
  }
}

/** O que o paciente recebeu, na ordem. */
async function mensagensQueSairam(): Promise<string[]> {
  const { rows } = await pool.query<{ body: string }>(
    `select body from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
      order by created_at, id`,
    [ORG, CONV],
  );
  return rows.map((r) => r.body);
}

/** O WhatsApp ACEITOU o que este job enviou: é o estado que vira `already_sent` no retry. */
async function canalAceita(jobId: string): Promise<void> {
  await pool.query(
    `update messages set status = 'sent'
      where organization_id = $1 and id in (select crm_message_id from send_ledger where job_id = $2)`,
    [ORG, jobId],
  );
  await pool.query(
    "update send_ledger set status = 'accepted' where organization_id = $1 and job_id = $2 and status = 'queued'",
    [ORG, jobId],
  );
}

async function statusDoJob(jobId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [jobId]);
  return rows[0]!.status;
}

async function jobsDeTurno(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from job_queue where organization_id = $1 and kind = 'inbound_turn'",
    [ORG],
  );
  return rows[0]!.n;
}

/**
 * A resposta à mensagem A saiu PELA METADE: a 1ª bolha chegou ao paciente, o
 * turno caiu antes da 2ª e o job voltou à fila esperando o retry. Devolve o job
 * e o handler dele (o roteiro continua de onde parou).
 */
async function respostaPelaMetade(
  retry: Passo[],
  aceito = true,
): Promise<{ jobA: string; handlerA: ReturnType<typeof handler> }> {
  const jobA = (await chegaEDrena("Tem horário essa semana?"))!;
  expect(jobA).not.toBeNull();
  const handlerA = handler([A1, FALHA, ...retry]);
  expect((await tenta(jobA, handlerA))?.message).toMatch(/modelo caiu/);
  if (aceito) await canalAceita(jobA);
  expect(await mensagensQueSairam()).toEqual([A1]);
  // `failJob` deixou o job `pending` com espera de 10 s: é a janela em que o paciente escreve de novo.
  const { rows } = await pool.query<{ no_futuro: boolean }>(
    "select status = 'pending' and run_after > now() as no_futuro from job_queue where id = $1",
    [jobA],
  );
  expect(rows[0]!.no_futuro).toBe(true);
  return { jobA, handlerA };
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    drainTick: (await import("@/lib/agent-engine/edge/crm/drain")).drainTick,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  adminFake.client = pgComoSupabase(pool);
  const { WahaChannelAdapter } = await import("@/lib/agent-engine/edge/channel/waha-adapter");
  canal = new WahaChannelAdapter(pool, { supabase: pgComoSupabase(pool) } as never);

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'carona-da-resposta','Carona da Resposta','Carona da Resposta')`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Paciente de teste','+5511900000978')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'carona-session','WORKING','\\x00'::bytea)`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
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
  chamadasDoModelo = 0;
  resultadosVistos = [];
  for (const t of ["send_ledger", "pacing_ledger", "outbound_copies", "job_queue", "event_log", "messages"]) {
    await pool.query(`delete from ${t} where organization_id = $1`, [ORG]);
  }
  await pool.query("update conversations set bot_silenced_until = null where id = $1", [CONV]);
  await pool.query("update contacts set force_human = false where id = $1", [CONTACT]);
});

// Job deste arquivo que ficasse `running` travaria o `claimJobs` seguinte.
afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("mensagem nova durante a espera do retry de uma resposta pela metade", () => {
  it("ganha turno próprio e é respondida UMA vez (o retry roda antes)", async () => {
    // No retry o modelo lê a conversa inteira e responde à mensagem nova numa bolha só.
    const { jobA, handlerA } = await respostaPelaMetade([RESPOSTA_B]);

    const jobB = await chegaEDrena(PERGUNTA_B);

    expect(await tenta(jobA, handlerA)).toBeNull();
    expect(await statusDoJob(jobA)).toBe("done");
    expect(await mensagensQueSairam()).toEqual([A1]);
    if (jobB !== null) expect(await tenta(jobB, handler([RESPOSTA_B]))).toBeNull();

    // O QUE O PACIENTE RECEBEU. De carona no job antigo, a resposta à mensagem
    // nova saía no `seq` 1 dele, que o ledger já tinha como aceito: engolida,
    // com o job `done` e sem aviso nenhum. A lista parava em [A1].
    expect(await mensagensQueSairam()).toEqual([A1, RESPOSTA_B]);

    expect(jobB).not.toBeNull();
    expect(jobB).not.toBe(jobA);
    // O retry não falou por cima: a mensagem nova tinha quem respondesse, e a
    // resposta dele ficou desatualizada (`resposta_obsoleta`, a régua de sempre).
    expect(JSON.stringify(resultadosVistos)).toMatch(/resposta_obsoleta/);
  });

  it("ganha turno próprio e é respondida UMA vez (o turno dela roda antes do retry)", async () => {
    const { jobA, handlerA } = await respostaPelaMetade([RESPOSTA_B]);
    const jobB = await chegaEDrena(PERGUNTA_B);
    expect(jobB).not.toBeNull();

    expect(await tenta(jobB!, handler([RESPOSTA_B]))).toBeNull();
    expect(await mensagensQueSairam()).toEqual([A1, RESPOSTA_B]);

    // O retry acorda depois: outro turno já viu e respondeu a última mensagem. Sem modelo, sem envio.
    const antes = chamadasDoModelo;
    expect(await tenta(jobA, handlerA)).toBeNull();
    expect(chamadasDoModelo).toBe(antes);
    expect(await mensagensQueSairam()).toEqual([A1, RESPOSTA_B]);
  });

  it("vale também para o envio que o canal reteve (`queued`): o retry reusa a mesma posição", async () => {
    const { jobA } = await respostaPelaMetade([RESPOSTA_B], false);
    const jobB = await chegaEDrena(PERGUNTA_B);
    expect(jobB).not.toBeNull();
    expect(jobB).not.toBe(jobA);
  });

  it("os dois turnos do mesmo paciente nunca rodam juntos: as bolhas de um não se misturam às do outro", async () => {
    const { jobA } = await respostaPelaMetade([RESPOSTA_B]);
    const jobB = await chegaEDrena(PERGUNTA_B);
    await pool.query("update job_queue set run_after = now() where id = any($1::uuid[])", [[jobA, jobB]]);

    const primeiros = await m.queue.claimJobs(pool, { workerId: "carona", maxConcurrency: 5 });
    expect(primeiros).toHaveLength(1);
    // Com um rodando, o outro não é entregue a ninguém.
    expect(await m.queue.claimJobs(pool, { workerId: "outro", maxConcurrency: 5 })).toHaveLength(0);
    await m.queue.completeJob(pool, primeiros[0]!.id, "carona");
    const depois = await m.queue.claimJobs(pool, { workerId: "outro", maxConcurrency: 5 });
    expect(depois.map((j) => j.id)).toEqual([jobA, jobB].filter((j) => j !== primeiros[0]!.id));
  });

  it("pessoa assumiu a conversa no intervalo: nem o retry nem o turno novo enviam", async () => {
    const { jobA, handlerA } = await respostaPelaMetade([A1, A2]);
    const jobB = await chegaEDrena(PERGUNTA_B);
    expect(jobB).not.toBeNull();
    await pool.query(
      "update conversations set bot_silenced_until = now() + interval '5 minutes' where id = $1",
      [CONV],
    );

    expect(await tenta(jobA, handlerA)).toBeNull();
    expect(await tenta(jobB!, handler([RESPOSTA_B]))).toBeNull();
    expect(await mensagensQueSairam()).toEqual([A1]);
  });

  it("conversa que não pode ter IA não ganha turno pela mensagem nova (silenciada)", async () => {
    await respostaPelaMetade([RESPOSTA_B]);
    await pool.query(
      "update conversations set bot_silenced_until = now() + interval '5 minutes' where id = $1",
      [CONV],
    );
    expect(await chegaEDrena(PERGUNTA_B)).toBeNull();
    expect(await jobsDeTurno()).toBe(1);
  });

  it("conversa que não pode ter IA não ganha turno pela mensagem nova (contato só com pessoa)", async () => {
    await respostaPelaMetade([RESPOSTA_B]);
    await pool.query("update contacts set force_human = true where id = $1", [CONTACT]);
    expect(await chegaEDrena(PERGUNTA_B)).toBeNull();
    expect(await jobsDeTurno()).toBe(1);
  });
});

describe("o que a carona e o ledger já garantiam continua valendo", () => {
  it("sem mensagem nova, o retry completa a resposta sem repetir a bolha que já saiu", async () => {
    const { jobA, handlerA } = await respostaPelaMetade([A1, A2]);
    expect(await tenta(jobA, handlerA)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([A1, A2]);
  });

  it("rajada: duas mensagens seguidas antes de qualquer envio viram UM turno e UMA resposta", async () => {
    const job = await chegaEDrena("Oi");
    expect(job).not.toBeNull();
    expect(await chegaEDrena("Tem horário essa semana?")).toBeNull();
    expect(await jobsDeTurno()).toBe(1);

    expect(await tenta(job!, handler([A1]))).toBeNull();
    expect(await mensagensQueSairam()).toEqual([A1]);
    expect(await jobsDeTurno()).toBe(1);
  });

  it("turno que falhou SEM nada ter chegado ao paciente continua dando carona", async () => {
    // O modelo caiu antes de enviar: não há posição ocupada no ledger, e o retry
    // lê a conversa inteira e responde a tudo.
    const job = (await chegaEDrena("Tem horário essa semana?"))!;
    const h = handler([FALHA, RESPOSTA_B]);
    expect((await tenta(job, h))?.message).toMatch(/modelo caiu/);

    expect(await chegaEDrena(PERGUNTA_B)).toBeNull();
    expect(await jobsDeTurno()).toBe(1);
    expect(await tenta(job, h)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([RESPOSTA_B]);
  });

  it("turno cujo único envio FALHOU continua dando carona: o retry reenvia naquela posição", async () => {
    const job = (await chegaEDrena("Tem horário essa semana?"))!;
    await pool.query(
      `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
       values ($1,$2,$3,1,'hash','failed')`,
      [ORG, CONTACT, job],
    );

    expect(await chegaEDrena(PERGUNTA_B)).toBeNull();
    expect(await jobsDeTurno()).toBe(1);
    expect(await tenta(job, handler([RESPOSTA_B]))).toBeNull();
    expect(await mensagensQueSairam()).toEqual([RESPOSTA_B]);
  });
});
