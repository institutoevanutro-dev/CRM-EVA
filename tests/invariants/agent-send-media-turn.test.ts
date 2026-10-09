import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as SendMessage from "@/lib/agent-engine/edge/crm/send-message";

/**
 * O turno COMPLETO mandando uma mídia da biblioteca (`send_media`). Harness igual a
 * `agent-send-template-turn.test.ts`: handler real, Postgres real, modelo fake via
 * `createFakeRegistry` e canal que CAPTURA em vez de enviar.
 *
 * Prova o que o guard de forma (`tests/unit/send-media-wiring.test.ts`) não alcança:
 * o id chega ao canal, a mídia gasta UM `seq`, a segunda mídia é recusada, a recusa
 * do handler vira ensino sem derrubar o job, e a tool e o bloco do prompt só existem
 * quando a organização tem item pronto.
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
  max: 2,
});

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";
const MSG = "eeeeeeee-0000-4000-8000-000000000005";
const ITEM = "eeeeeeee-0000-4000-8000-000000000009";

interface EnvioCapturado {
  body: string;
  seq: number;
  mediaLibraryItemId?: string;
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  MidiaRecusadaError: typeof SendMessage.MidiaRecusadaError;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
let resultadosVistos: unknown[] = [];
/** O que o modelo recebeu na 1ª chamada: o prompt de sistema e os nomes das tools. */
let sistemaVisto = "";
let toolsOferecidas: string[] = [];

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

/** Modelo fake que faz as chamadas de tool em ordem, uma por passo, e então fecha. */
function modeloQueChama(chamadas: Array<{ tool: string; input: Record<string, unknown> }>) {
  let i = 0;
  let primeira = true;
  return async (opts: { prompt?: unknown; tools?: Array<{ name: string }> }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    if (primeira) {
      primeira = false;
      sistemaVisto = msgs
        .filter((msg) => msg.role === "system")
        .map((msg) => (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)))
        .join("\n");
      toolsOferecidas = (opts.tools ?? []).map((t) => t.name);
    }
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") resultadosVistos.push(parte.output ?? parte);
      }
    }
    const proxima = chamadas[i];
    if (proxima === undefined) {
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    i += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${i}`,
          toolName: proxima.tool,
          input: JSON.stringify(proxima.input),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function montaHandler(doGenerate: unknown, envia?: (i: EnvioCapturado) => Promise<unknown>) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
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
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send:
          envia ??
          (async (i: EnvioCapturado) => {
            enviados.push(i);
            return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
          }),
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Terça, 15h BRT: dentro da janela anti-ban.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

/** Roda um turno com `maxAttempts: 3`: um run que lançasse voltaria para a fila. */
async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<{ erro: Error | null; jobId: string }> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: "eeeeeeee-0000-4000-8000-000000000006",
    },
    maxAttempts: 3,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "midia", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "midia" });
    await m.queue.completeJob(pool, claimed!.id, "midia");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "midia", err);
    return { erro: err as Error, jobId: job.id };
  }
}

const mandaMidia = (caption?: string) => ({
  tool: "send_media",
  input: caption === undefined ? { media_id: ITEM } : { media_id: ITEM, caption },
});

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    MidiaRecusadaError: (await import("@/lib/agent-engine/edge/crm/send-message")).MidiaRecusadaError,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'send-media-turn','Send Media Turn','Send Media Turn') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Mídia','+5511900000999') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'send-media-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  // Item PRONTO: tem arquivo e não mostra pessoa (sem termo a exigir).
  await pool.query(
    `insert into media_library_items (id, organization_id, title, when_to_use, tags, variants, contains_person)
     values ($1,$2,'Antes e depois','quando perguntarem do resultado','{resultado}',$3::jsonb,false)
     on conflict (id) do nothing`,
    [ITEM, ORG, JSON.stringify([{ key: "A", storage_path: `${ORG}/${ITEM}/A-x.png`, mime: "image/png", size_bytes: 10 }])],
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

beforeEach(() => {
  enviados = [];
  resultadosVistos = [];
  sistemaVisto = "";
  toolsOferecidas = [];
});

describe("turno completo — send_media com item pronto na biblioteca", () => {
  it("o prompt traz a BIBLIOTECA DE MÍDIAS e a tool é oferecida", async () => {
    const { erro } = await rodaTurno(montaHandler(modeloQueChama([])));
    expect(erro).toBeNull();
    expect(sistemaVisto).toContain("BIBLIOTECA DE MÍDIAS");
    expect(sistemaVisto).toContain(ITEM);
    expect(toolsOferecidas).toContain("send_media");
  });

  it("a mídia chega ao canal com o id da biblioteca e gasta UM seq", async () => {
    const { erro } = await rodaTurno(
      montaHandler(
        modeloQueChama([
          mandaMidia("olha o resultado da paciente"),
          { tool: "send_message", input: { body: "gostou? posso te explicar o procedimento" } },
        ]),
      ),
    );
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(2);
    expect(enviados[0]).toMatchObject({
      seq: 1,
      mediaLibraryItemId: ITEM,
      body: "olha o resultado da paciente",
    });
    // O texto seguinte é o seq 2: a mídia não foi quebrada em balões.
    expect(enviados[1]).toMatchObject({ seq: 2 });
    expect(enviados[1]!.mediaLibraryItemId).toBeUndefined();
  });

  it("a segunda mídia no mesmo turno é recusada com max_media_per_turn", async () => {
    const { erro } = await rodaTurno(montaHandler(modeloQueChama([mandaMidia(), mandaMidia()])));
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.mediaLibraryItemId).toBe(ITEM);
    expect(JSON.stringify(resultadosVistos)).toMatch(/max_media_per_turn/);
  });

  it("id fora da lista é media_not_found e nada sai", async () => {
    const { erro } = await rodaTurno(
      montaHandler(
        modeloQueChama([{ tool: "send_media", input: { media_id: "eeeeeeee-0000-4000-8000-0000000000ff" } }]),
      ),
    );
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toMatch(/media_not_found/);
  });

  it("recusa do canal (MidiaRecusadaError) ensina o modelo, o run não lança e o job não volta à fila", async () => {
    const { erro, jobId } = await rodaTurno(
      montaHandler(modeloQueChama([mandaMidia()]), async () => {
        throw new m.MidiaRecusadaError("media_not_ready", "o termo de uso desta mídia venceu.", "req-1", "termo_vencido");
      }),
    );
    expect(erro).toBeNull();
    expect(JSON.stringify(resultadosVistos)).toMatch(/media_not_ready/);
    const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [jobId]);
    expect(rows[0]!.status).toBe("done");
  });
});

describe("turno completo — organização sem item pronto", () => {
  it("nem o bloco nem a tool existem, e a tentativa do modelo não envia nada", async () => {
    await pool.query("delete from media_library_items where organization_id = $1", [ORG]);
    const { erro } = await rodaTurno(montaHandler(modeloQueChama([mandaMidia()])));
    // O desfecho de chamar tool inexistente é do SDK; o que importa é que nada saiu.
    void erro;
    expect(sistemaVisto).not.toContain("BIBLIOTECA DE MÍDIAS");
    expect(toolsOferecidas).not.toContain("send_media");
    expect(enviados).toHaveLength(0);
  });
});
