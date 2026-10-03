import { expect } from "vitest";
import pg from "pg";

import type { embedText } from "@/lib/ai/embed";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type { ChannelAdapter, ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O TURNO INTEIRO CONTRA POSTGRES DE VERDADE — harness de `resposta-pronta-no-turno`.
 * Espelha o de `handoff-avisa-o-lead.test.ts`, que é congelado (freeze-invariants) e por isso guarda a própria cópia.
 *
 * `createInboundTurnHandler` real, canal que CAPTURA em vez de enviar,
 * `createFakeRegistry` para o modelo (um CONTROLE que conta as chamadas),
 * relógio fixo dentro da janela anti-ban (sem ele o `pacing` veta e a medição é
 * do motivo errado) e `sleep` no-op.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);

export function abrirPool(): pg.Pool {
  return new pg.Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
    max: 2,
  });
}

/** Terça, 15h BRT: dentro da janela anti-ban (7h-22h). */
export const AGORA = new Date("2026-07-28T18:00:00Z");

/** A conversa sob teste. */
export interface Alvo {
  org: string;
  contact: string;
  session: string;
  conv: string;
}

export type Motor = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};

/** Import tardio: as envs acima têm de existir antes de o motor carregar. */
export async function carregarMotor(): Promise<Motor> {
  return {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
}

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Modelo de CONTROLE: encerra o turno com um checkpoint válido e avisa cada
 * chamada. Um turno de IA de verdade chama pelo menos duas vezes (turno +
 * checkpoint de fechamento); um desvio determinístico, zero.
 */
export function modeloDeControle(aoChamar: () => void) {
  return async () => {
    aoChamar();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            commitments: [],
            objections: [],
            next_action: null,
            rolling_summary: "turno de teste",
          }),
        },
      ],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

/** Canal que entrega a `capturar` o que seria enviado e responde `sent` com o número devolvido. */
export function canalQueCaptura(capturar: (i: ChannelSendInput) => Promise<number>): ChannelAdapter {
  return {
    channel: "captura",
    send: async (i) => {
      const n = await capturar(i);
      return { kind: "sent", idempotencyKey: `k${n}`, messageId: `m${n}` };
    },
    sessionHealth: async () => ({ healthy: true, status: "WORKING", since: null }),
    capabilities: () => ({ freeformAnytime: true, serviceWindowHours: null }),
    costPerMessage: () => ({ perMessageUsdCents: 0, model: "flat" }),
  };
}

export function montaHandler(
  m: Motor,
  o: { aoChamarModelo: () => void; canal: () => ChannelAdapter; embed?: typeof embedText },
) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
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
    registry: m.createFakeRegistry(modeloDeControle(o.aoChamarModelo) as never),
    ...(o.embed !== undefined ? { embed: o.embed } : {}),
    channel: o.canal,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

/** Organização, sessão do canal e a camada `platform` do playbook (o ritual de abertura recusa o turno sem ela). */
export async function semearBase(pool: pg.Pool, a: Alvo, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2::text,$2::text,$2::text) on conflict (id) do nothing`,
    [a.org, slug],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,$3,'WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [a.session, a.org, `${slug}-session`],
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
}

/**
 * Estado limpo a cada caso: `force_human` é IRREVOGÁVEL em produção, então um
 * caso herdando a trava do anterior mediria o turno pulado, não o desvio.
 */
export async function recriarConversa(pool: pg.Pool, a: Alvo, nome: string, telefone: string): Promise<void> {
  for (const t of ["messages", "send_ledger", "outbound_copies", "agent_inbox_items", "llm_calls", "conversations", "contacts"]) {
    await pool.query(`delete from ${t} where organization_id = $1`, [a.org]);
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number, force_human) values ($1,$2,$3,$4, false)`,
    [a.contact, a.org, nome, telefone],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [a.conv, a.org, a.contact, a.session],
  );
}

export async function gravarInbound(pool: pg.Pool, a: Alvo, texto: string, segundos = 0): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device', now() + ($7 || ' seconds')::interval)`,
    [id, a.org, a.conv, a.session, a.contact, texto, String(segundos)],
  );
  return id;
}

export function enfileirar(pool: pg.Pool, m: Motor, a: Alvo, inboundMessageId: string) {
  return m.queue.enqueueJob(pool, a.org, {
    kind: "inbound_turn",
    leadId: a.contact,
    payload: {
      conversation_id: a.conv,
      contact_id: a.contact,
      channel_session_id: a.session,
      inbound_message_id: inboundMessageId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
}

/** Grava os inbounds (uma rajada, um segundo entre cada) e roda UM turno pinado no primeiro. */
export async function rodaTurno(
  pool: pg.Pool,
  m: Motor,
  a: Alvo,
  handler: ReturnType<typeof montaHandler>,
  textos: readonly string[],
  workerId: string,
): Promise<void> {
  const ids: string[] = [];
  for (const [i, texto] of textos.entries()) ids.push(await gravarInbound(pool, a, texto, i));
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await enfileirar(pool, m, a, ids[0]!);
  const [claimed] = await m.queue.claimJobs(pool, { workerId, maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId });
    await m.queue.completeJob(pool, claimed!.id, workerId);
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, workerId, err);
    throw err;
  }
}
