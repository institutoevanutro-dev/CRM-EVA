import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as WahaAdapter from "@/lib/agent-engine/edge/channel/waha-adapter";

/**
 * O turno COMPLETO passando a conversa para outro assunto do roteador
 * (`transfer_to_subject`). Harness de `agent-send-media-turn.test.ts` (handler
 * real, Postgres real, modelo fake com roteiro de tool calls), com duas
 * diferenças que são o que está sob teste:
 *
 *  - o modelo fake tem UM ROTEIRO POR AGENTE e sabe quem está falando pelo
 *    prompt de sistema: a reexecução troca de agente dentro do mesmo job;
 *  - o canal é o REAL do motor (`WahaChannelAdapter` -> ledger -> handler), como
 *    em `ia-nao-fala-por-cima-de-quem-assumiu.test.ts`: "uma resposta só" é
 *    medida no `send_ledger`, que é quem segura a duplicata no retry. Sem WAHA
 *    configurado a mensagem fica `queued`, sem rede.
 *
 * O classificador do roteador é dublado e devolve "falhou": com agente atual
 * isso mantém quem está atendendo (regra 4), e nenhum caso depende de rede.
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

const id = (n: number) => `eed30000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const CONTACT = id(2);
const SESSION = id(3);
const CONV = id(4);
const MSG = id(5);
const ROUTER = id(6);
const A = id(10);
const B = id(11);
const SEM_VERSAO = id(12);
const PAUSADO = id(13);
const FECHADO = id(14);
const ASSISTIDO = id(15);

const adminFake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFake.client }));
// Só `classifyIntent` é dublado; o resto do módulo é o real.
vi.mock("@/lib/agent-engine/agent/intent-classifier", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  classifyIntent: async () => null,
}));

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  runAgentTurn: typeof InboundTurn.runAgentTurn;
  buildOpeningMessage: typeof InboundTurn.buildOpeningMessage;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  WahaChannelAdapter: typeof WahaAdapter.WahaChannelAdapter;
};
let m: Modules;
let canal: WahaAdapter.WahaChannelAdapter;

type Quem = "A" | "B";
/** Cada chamada de modelo: quem falava, o prompt de sistema e as tools oferecidas ([] = fechamento). */
let chamadas: Array<{ quem: Quem; sistema: string; tools: string[] }> = [];
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

type Chamada = { tool: string; input: Record<string, unknown> };
/** Um passo: uma tool, várias no MESMO passo (o SDK as roda em paralelo) ou o modelo caindo. */
type Passo = Chamada | Chamada[] | "falha";

const passa = (subject: string): Chamada => ({
  tool: "transfer_to_subject",
  input: { subject, reason: "a pessoa mudou de assunto" },
});
const envia = (body: string): Chamada => ({ tool: "send_message", input: { body } });

/** Modelo fake com um roteiro POR AGENTE. O estado vive no closure: sobrevive ao retry do job. */
function modelo(
  roteiros: Partial<Record<Quem, Passo[]>>,
  ganchos: { fechamentosQueFalham?: number; aoChamar?: (quem: Quem) => Promise<void> } = {},
) {
  const pos: Record<Quem, number> = { A: 0, B: 0 };
  let fechamentosQueFalham = ganchos.fechamentosQueFalham ?? 0;
  let n = 0;
  return async (opts: { prompt?: unknown; tools?: Array<{ name: string }> }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const sistema = msgs
      .filter((msg) => msg.role === "system")
      .map((msg) => (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)))
      .join("\n");
    const quem: Quem = sistema.includes("ROTEIRO-B") ? "B" : "A";
    const tools = (opts.tools ?? []).map((t) => t.name);
    chamadas.push({ quem, sistema, tools });
    await ganchos.aoChamar?.(quem);
    for (const msg of msgs) {
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
    if (tools.length === 0) {
      if (fechamentosQueFalham > 0) {
        fechamentosQueFalham -= 1;
        throw new Error("modelo caiu no fechamento");
      }
      return fecha;
    }
    const proximo = roteiros[quem]?.[pos[quem]];
    if (proximo === undefined) return fecha;
    pos[quem] += 1;
    if (proximo === "falha") throw new Error("modelo caiu no meio do turno");
    n += 1;
    return {
      content: (Array.isArray(proximo) ? proximo : [proximo]).map((c, k) => ({
        type: "tool-call" as const,
        toolCallId: `c${n}-${k}`,
        toolName: c.tool,
        input: JSON.stringify(c.input),
      })),
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function deps(doGenerate: unknown) {
  return {
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
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () => canal,
    // Terça, 15h BRT: dentro da janela anti-ban.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  } as InboundTurn.InboundTurnDeps;
}

async function enfileira(kind: "inbound_turn" | "followup_turn" = "inbound_turn", msg = MSG): Promise<string> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind,
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 3,
  });
  return job.id;
}

/** Reivindica o job e roda o handler real. Devolve o erro (o job volta à fila) ou null (`done`). */
async function tenta(jobId: string, handler: ReturnType<Modules["createInboundTurnHandler"]>): Promise<Error | null> {
  // Uma falha anterior deixou o job com espera de retry: aqui ele roda já.
  await pool.query("update job_queue set run_after = now() where id = $1 and status = 'pending'", [jobId]);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "passagem", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  try {
    await handler(claimed!, pool, { workerId: "passagem" });
    await m.queue.completeJob(pool, claimed!.id, "passagem");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "passagem", err);
    return err as Error;
  }
}

/** Uma mensagem nova do cliente, mais nova que tudo o que já está na conversa. */
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

async function rodaTurno(
  roteiros: Partial<Record<Quem, Passo[]>>,
  msg = MSG,
): Promise<{ erro: Error | null; jobId: string }> {
  const jobId = await enfileira("inbound_turn", msg);
  return { erro: await tenta(jobId, m.createInboundTurnHandler(deps(modelo(roteiros)))), jobId };
}

async function dono(): Promise<{ agente: string | null; assunto: string | null }> {
  const { rows } = await pool.query<{ active_ai_agent_id: string | null; active_intent: string | null }>(
    "select active_ai_agent_id, active_intent from conversations where id = $1",
    [CONV],
  );
  return { agente: rows[0]!.active_ai_agent_id, assunto: rows[0]!.active_intent };
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

/** Envios do job que o canal aceitou (ou enfileirou): é o que o retry não pode repetir. */
async function enviosAceitos(jobId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from send_ledger where job_id = $1 and status in ('accepted','queued')",
    [jobId],
  );
  return rows[0]!.n;
}

/**
 * O canal ACEITOU o que este job enviou. Sem WAHA no harness a linha fica
 * `queued`; em produção ela fica `accepted`, e é esse estado que faz o ledger
 * devolver `already_sent` no retry em vez de reenviar.
 */
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

async function payloadDoJob(jobId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>("select payload from job_queue where id = $1", [jobId]);
  return rows[0]!.payload;
}

/** Uma mensagem nova chega e o drain decide: carona no job pendente ou job próprio. Devolve o job próprio, se houver. */
async function chegaEDrena(texto: string, jobAntigo: string): Promise<string | null> {
  const m2 = await novaInbound(texto);
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid, $3::jsonb, 'pending')`,
    [ORG, m2, JSON.stringify({ conversation_id: CONV, contact_id: CONTACT, channel_session_id: SESSION, inbound_message_id: m2 })],
  );
  const { drainTick } = await import("@/lib/agent-engine/edge/crm/drain");
  await drainTick(
    pool,
    { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 3000, reapTimeoutMs: 300_000 },
    m.createLogger(),
  );
  const { rows } = await pool.query<{ id: string }>(
    `select id from job_queue
      where organization_id = $1 and kind = 'inbound_turn' and id <> $2
        and payload->>'inbound_message_id' = $3`,
    [ORG, jobAntigo, m2],
  );
  await pool.query("delete from event_log where organization_id = $1 and event_type = 'ai_agent.dispatch_requested'", [ORG]);
  return rows[0]?.id ?? null;
}

async function atividadesDaPassagem() {
  const { rows } = await pool.query<{ reason: string; payload: Record<string, unknown>; actor_agent_id: string | null; source_id: string | null }>(
    `select reason, payload, actor_agent_id, source_id from crm_lead_activities
      where organization_id = $1 and type = 'subject_transferred' order by created_at`,
    [ORG],
  );
  return rows;
}

async function decisoes(jobId: string) {
  const { rows } = await pool.query<{ outcome: string; confidence: string | null; agent_id: string | null; intent_name: string | null }>(
    "select outcome, confidence, agent_id, intent_name from ai_router_decisions where job_id = $1 order by created_at, id",
    [jobId],
  );
  return rows;
}

async function turnosDoOperador(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from job_queue where organization_id = $1 and kind = 'operator_turn'",
    [ORG],
  );
  return rows[0]!.n;
}

const comTools = (quem: Quem) => chamadas.filter((c) => c.quem === quem && c.tools.length > 0);
const vistos = () => JSON.stringify(resultadosVistos);

async function agente(
  agentId: string,
  nome: string,
  prompt: string,
  opts: { publicado?: boolean; operador?: boolean; trigger?: Record<string, unknown> } = {},
) {
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind) values ($1,$2,$3,$4,'mcp_agent')`,
    [agentId, ORG, nome, prompt],
  );
  if (opts.publicado === false) return;
  const versao = crypto.randomUUID();
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, operator_enabled,
                                    trigger_config)
     values ($1,$2,$3,1,$4,'anthropic','claude-sonnet-4-6',$5,'published', now(), $6, $7::jsonb)`,
    [versao, ORG, agentId, prompt, SESSION, opts.operador === true, JSON.stringify(opts.trigger ?? {})],
  );
  await pool.query("update ai_agents set published_version_id = $1 where id = $2", [versao, agentId]);
}

async function configDoRoteador(config: Record<string, unknown>) {
  await pool.query("update ai_routers set config = $2::jsonb where id = $1", [ROUTER, JSON.stringify(config)]);
}
const MODO_NOVO = { permanencia: "agente", interrompe: [], min_confidence: 0.8, sticky: true };

beforeAll(async () => {
  const turno = await import("@/lib/agent-engine/agent/inbound-turn");
  m = {
    createInboundTurnHandler: turno.createInboundTurnHandler,
    runAgentTurn: turno.runAgentTurn,
    buildOpeningMessage: turno.buildOpeningMessage,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    WahaChannelAdapter: (await import("@/lib/agent-engine/edge/channel/waha-adapter")).WahaChannelAdapter,
  };
  adminFake.client = pgComoSupabase(pool);
  canal = new m.WahaChannelAdapter(pool, { supabase: pgComoSupabase(pool) } as never);

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'passagem-de-assunto','Passagem de Assunto','Passagem de Assunto')`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Paciente de teste','+5511900000977')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'passagem-session','WORKING','\\x00'::bytea)`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','E a drenagem, vocês fazem?','external_device', now())`,
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

  // A tem o papel do Operador ligado: um turno de A que fecha normalmente enfileira `operator_turn`.
  await agente(A, "Agente A", "ROTEIRO-A: você agenda consultas.", { operador: true });
  await agente(B, "Agente B", "ROTEIRO-B: você cuida de drenagem.");
  await agente(SEM_VERSAO, "Agente sem versão", "ROTEIRO-C", { publicado: false });
  await agente(PAUSADO, "Agente pausado", "ROTEIRO-D");
  await pool.query("update ai_agents set paused_at = now() where id = $1", [PAUSADO]);
  // O relógio do turno é terça, 15h em São Paulo: esta janela está fechada.
  await agente(FECHADO, "Agente fora do horário", "ROTEIRO-E", {
    trigger: {
      filters: { business_hours: { timezone: "America/Sao_Paulo", start: "08:00", end: "09:00", weekdays: [1, 2, 3, 4, 5] } },
    },
  });
  await agente(ASSISTIDO, "Agente assistido", "ROTEIRO-F");
  await pool.query("update ai_agents set operation_mode = 'assisted' where id = $1", [ASSISTIDO]);

  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, config)
     values ($1,$2,'Roteador de teste',$3,true,$4::jsonb)`,
    [ROUTER, ORG, SESSION, JSON.stringify(MODO_NOVO)],
  );
  const membros: Array<[string, string, string]> = [
    [A, "a", "Agendar consulta"],
    [B, "b", "Drenagem linfática"],
    [SEM_VERSAO, "c", "Assunto sem agente publicado"],
    [PAUSADO, "d", "Assunto de agente pausado"],
    [FECHADO, "e", "Assunto de agente fora do horário"],
    [ASSISTIDO, "f", "Assunto de agente assistido"],
  ];
  for (const [i, [agentId, intent, descricao]] of membros.entries()) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description, position)
       values ($1,$2,$3,$4,$5,$6)`,
      [ORG, ROUTER, agentId, intent, descricao, i],
    );
  }
});

beforeEach(async () => {
  chamadas = [];
  resultadosVistos = [];
  for (const t of ["send_ledger", "pacing_ledger", "outbound_copies", "job_queue", "ai_router_decisions"]) {
    await pool.query(`delete from ${t} where organization_id = $1`, [ORG]);
  }
  await pool.query("delete from event_log where organization_id = $1 and event_type = 'agent.activity_unrouted'", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and id <> $2", [ORG, MSG]);
  await pool.query("update conversations set active_ai_agent_id = $2, active_intent = 'a' where id = $1", [CONV, A]);
  await configDoRoteador(MODO_NOVO);
});

// Job deste arquivo que ficasse `running` travaria o `claimJobs` seguinte.
afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.end();
});

describe("transfer_to_subject: o agente passa a conversa e o destino responde a mesma mensagem", () => {
  it("caso 1: A passa sem enviar, B responde no mesmo job, uma vez só", async () => {
    const { erro, jobId } = await rodaTurno({ A: [passa("b")], B: [envia("Fazemos sim, drenagem é comigo.")] });
    expect(erro).toBeNull();

    expect(await dono()).toEqual({ agente: B, assunto: "b" });
    // A linha `sticky` é a do roteador ao abrir o turno com A; a da passagem é a
    // única do destino: a reexecução não grava a sua.
    expect(await decisoes(jobId)).toEqual([
      { outcome: "sticky", confidence: null, agent_id: A, intent_name: "a" },
      { outcome: "reclassified", confidence: null, agent_id: B, intent_name: "b" },
    ]);

    // B rodou com o roteiro dele, e a resposta é a dele.
    expect(comTools("B").length).toBeGreaterThan(0);
    expect(comTools("B")[0]!.sistema).toContain("ROTEIRO-B");
    expect(comTools("B")[0]!.sistema).not.toContain("ROTEIRO-A");
    expect(await mensagensQueSairam()).toEqual(["Fazemos sim, drenagem é comigo."]);
    expect(await enviosAceitos(jobId)).toBe(1);

    // A foi chamado UMA vez: sem correção de turno mudo e sem fechamento do turno que passou.
    expect(chamadas.filter((c) => c.quem === "A")).toHaveLength(1);
    // Nem aviso de escalação, nem Operador para o turno de A (B não tem o papel).
    expect(await mensagensQueSairam()).toHaveLength(1);
    expect(await turnosDoOperador()).toBe(0);
    const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [jobId]);
    expect(rows[0]!.status).toBe("done");

    // Este contato não tem negócio aberto: a atividade da passagem não adivinha
    // um card. Fica registrada onde o motor registra atividade sem negócio.
    expect(await atividadesDaPassagem()).toEqual([]);
    const { rows: semRota } = await pool.query<{ payload: { activity_type: string; reason: string } }>(
      "select payload from event_log where organization_id = $1 and event_type = 'agent.activity_unrouted' and entity_id = $2",
      [ORG, CONTACT],
    );
    expect(semRota.map((r) => r.payload.activity_type)).toEqual(["subject_transferred"]);
  });

  it("a passagem aparece na linha do tempo do negócio: os dois assuntos, os dois agentes e o motivo", async () => {
    const { rows: funil } = await pool.query<{ id: string }>(
      "insert into crm_pipelines (organization_id, name, slug, position) values ($1, 'Funil da passagem', 'funil-da-passagem', 100) returning id",
      [ORG],
    );
    const { rows: etapa } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, agent_stage_hint)
       values ($1, $2, 'Entrada', 'entrada-da-passagem', 1, 'new') returning id`,
      [ORG, funil[0]!.id],
    );
    await pool.query(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status)
       values ($1, $2, $3, $4, 'Negócio da paciente', 'open')`,
      [ORG, funil[0]!.id, etapa[0]!.id, CONTACT],
    );
    try {
      const jobId = await enfileira();
      const handler = m.createInboundTurnHandler(
        deps(
          modelo({
            A: [{ tool: "transfer_to_subject", input: { subject: "b", reason: "ela perguntou\nde drenagem" } }],
            B: [envia("Fazemos sim.")],
          }),
        ),
      );
      expect(await tenta(jobId, handler)).toBeNull();

      const atividades = await atividadesDaPassagem();
      expect(atividades).toHaveLength(1);
      expect(atividades[0]!.reason).toBe(
        "Do assunto a (Agente A) para o assunto b (Agente B). Motivo: ela perguntou de drenagem",
      );
      expect(atividades[0]!.payload).toMatchObject({
        conversation_id: CONV,
        de_assunto: "a",
        de_agent_id: A,
        de_agente: "Agente A",
        para_assunto: "b",
        para_agent_id: B,
        para_agente: "Agente B",
      });
      expect(atividades[0]!.actor_agent_id).toBe(A);
      expect(atividades[0]!.source_id).toBe(CONV);
      // O motivo é texto do modelo sobre a conversa: não vai para a tabela de decisões.
      const { rows: decisao } = await pool.query<{ linha: string }>(
        "select row_to_json(d)::text as linha from ai_router_decisions d where job_id = $1",
        [jobId],
      );
      for (const d of decisao) expect(d.linha).not.toContain("drenagem");
      expect(await mensagensQueSairam()).toEqual(["Fazemos sim."]);
    } finally {
      await pool.query("delete from crm_lead_activities where organization_id = $1", [ORG]);
      await pool.query("delete from crm_leads where organization_id = $1", [ORG]);
      await pool.query("delete from crm_stages where organization_id = $1", [ORG]);
      await pool.query("delete from crm_pipelines where organization_id = $1", [ORG]);
    }
  });

  it("caso 2: na reexecução B não tem a ferramenta nem o bloco; A tem os dois", async () => {
    await rodaTurno({ A: [passa("b")], B: [envia("Oi, sou eu que cuido disso.")] });

    expect(comTools("A")[0]!.tools).toContain("transfer_to_subject");
    expect(comTools("A")[0]!.sistema).toContain("Outros assuntos deste atendimento");
    // O bloco lista os outros assuntos, nunca o do próprio agente.
    expect(comTools("A")[0]!.sistema).toContain("- b: Drenagem linfática");
    expect(comTools("A")[0]!.sistema).not.toContain("- a: Agendar consulta");

    expect(comTools("B")[0]!.tools).not.toContain("transfer_to_subject");
    expect(comTools("B")[0]!.sistema).not.toContain("Outros assuntos deste atendimento");
  });

  it("caso 3: A envia e passa no mesmo passo: sem reexecução, uma mensagem (a de A), dono novo é B", async () => {
    const saida = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { erro, jobId } = await rodaTurno({
      A: [[envia("Vou te passar para quem cuida de drenagem."), passa("b")]],
      B: [envia("B não deveria falar neste turno.")],
    });
    const aviso = saida.mock.calls.map((c) => String(c[0])).find((l) => l.includes("passagem com envio no mesmo turno"));
    saida.mockRestore();
    expect(erro).toBeNull();

    // Quem lê o log sabe por que B não respondeu esta mensagem. Só ids e o
    // assunto: nada do que a pessoa escreveu.
    expect(JSON.parse(aviso!)).toMatchObject({
      level: "warn",
      conversation_id: CONV,
      de_agent_id: A,
      para_agent_id: B,
      para_assunto: "b",
    });
    expect(aviso).not.toContain("drenagem, vocês fazem");

    expect(comTools("B")).toHaveLength(0);
    expect(await mensagensQueSairam()).toEqual(["Vou te passar para quem cuida de drenagem."]);
    expect(await enviosAceitos(jobId)).toBe(1);
    expect(await dono()).toEqual({ agente: B, assunto: "b" });
    expect((await decisoes(jobId)).map((d) => d.outcome)).toEqual(["sticky", "reclassified"]);
    // A parou depois da passagem: nenhum passo a mais com tools.
    expect(comTools("A")).toHaveLength(1);
    // O turno de A fechou com a declaração dele: é o Operador quem a cumpre.
    expect(await turnosDoOperador()).toBe(1);
  });

  it.each([
    ["sem versão publicada", "c"],
    ["pausado", "d"],
    ["fora do horário de funcionamento", "e"],
    ["em modo assistido", "f"],
  ])("caso 4: destino %s devolve destino_indisponivel, o dono não muda e A responde", async (_, assunto) => {
    const { erro, jobId } = await rodaTurno({ A: [passa(assunto), envia("Sigo com você por aqui.")] });
    expect(erro).toBeNull();

    expect(vistos()).toMatch(/destino_indisponivel/);
    expect(await dono()).toEqual({ agente: A, assunto: "a" });
    expect((await decisoes(jobId)).map((d) => d.outcome)).toEqual(["sticky"]);
    expect(await mensagensQueSairam()).toEqual(["Sigo com você por aqui."]);
    expect(comTools("B")).toHaveLength(0);
  });

  it.each([
    ["que não é membro", "implante"],
    ["do próprio agente", "a"],
  ])("caso 5: assunto %s devolve assunto_invalido com a lista dos válidos", async (_, assunto) => {
    const { erro, jobId } = await rodaTurno({ A: [passa(assunto), envia("Me conta mais?")] });
    expect(erro).toBeNull();

    expect(vistos()).toMatch(/assunto_invalido/);
    expect(vistos()).toMatch(/b, c, d/);
    expect(await dono()).toEqual({ agente: A, assunto: "a" });
    expect((await decisoes(jobId)).map((d) => d.outcome)).toEqual(["sticky"]);
    expect(await mensagensQueSairam()).toEqual(["Me conta mais?"]);
  });

  it("payload fora da forma é erro de ensino, não passagem", async () => {
    const { erro } = await rodaTurno({
      A: [{ tool: "transfer_to_subject", input: { subject: "b", reason: "x", agent_id: B } }, envia("Certo.")],
    });
    expect(erro).toBeNull();
    expect(vistos()).toMatch(/invalid_payload/);
    expect(await dono()).toEqual({ agente: A, assunto: "a" });
  });
});

describe("transfer_to_subject: retry do job depois da passagem", () => {
  it("caso 6: B enviou a bolha 1 e falhou antes da 2: o retry completa a resposta sem repetir a bolha 1", async () => {
    const b1 = "Fazemos drenagem sim.";
    const b2 = "Quer que eu veja um horário?";
    const handler = m.createInboundTurnHandler(
      deps(modelo({ A: [passa("b")], B: [envia(b1), "falha", envia(b1), envia(b2)] })),
    );
    const jobId = await enfileira();

    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu/);
    expect(await mensagensQueSairam()).toEqual([b1]);
    await canalAceita(jobId);
    // Quem enviou foi o DESTINO: o job passou, mas não leva a marca de envio da origem.
    expect(await payloadDoJob(jobId)).toMatchObject({ passagem_feita: true });
    expect(await payloadDoJob(jobId)).not.toHaveProperty("passagem_com_envio_da_origem");

    expect(await tenta(jobId, handler)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([b1, b2]);
    expect(await enviosAceitos(jobId)).toBe(2);
    expect(await dono()).toEqual({ agente: B, assunto: "b" });
    // O retry é do destino: a origem não roda de novo e ele não pode devolver a conversa.
    expect(chamadas.filter((c) => c.quem === "A")).toHaveLength(1);
    for (const c of comTools("B")) expect(c.tools).not.toContain("transfer_to_subject");
    const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [jobId]);
    expect(rows[0]!.status).toBe("done");
  });

  // O retry roda o modelo de novo e o texto pode vir outro. O ledger é por
  // posição (job, seq), não por conteúdo: o que cair numa posição já aceita não
  // sai, o que cair numa posição nova sai. É o comportamento de qualquer job
  // deste motor; aqui fica medido para a passagem.
  it.each([
    ["outra abertura e a mesma continuação", ["Outra abertura de B."], ["Fazemos drenagem sim.", "Quer que eu veja um horário?"]],
    ["a resposta inteira numa bolha só (limite conhecido: nada novo sai)", [], ["Fazemos drenagem sim."]],
  ])("caso 6, texto diferente no retry: %s", async (_, abertura, esperado) => {
    const handler = m.createInboundTurnHandler(
      deps(
        modelo({
          A: [passa("b")],
          B: [
            envia("Fazemos drenagem sim."),
            "falha",
            ...(abertura.length > 0
              ? [envia(abertura[0]!), envia("Quer que eu veja um horário?")]
              : [envia("Fazemos drenagem sim. Quer que eu veja um horário?")]),
          ],
        }),
      ),
    );
    const jobId = await enfileira();
    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu/);
    await canalAceita(jobId);

    expect(await tenta(jobId, handler)).toBeNull();
    expect(await mensagensQueSairam()).toEqual(esperado);
  });

  it("mensagem nova durante a espera do retry de um job em que B respondeu pela metade ganha job próprio, e é respondida", async () => {
    const b1 = "Fazemos drenagem sim.";
    const b2 = "Quer que eu veja um horário?";
    const handler = m.createInboundTurnHandler(
      deps(modelo({ A: [passa("b")], B: [envia(b1), "falha", envia(b1), envia(b2)] })),
    );
    const jobId = await enfileira();
    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu/);
    await canalAceita(jobId);
    await pool.query("update job_queue set run_after = now() + interval '30 seconds' where id = $1", [jobId]);

    // Sem carona: a resposta à mensagem nova sairia no `seq` 1 deste job, que o
    // ledger já tem como aceito, e seria engolida.
    const novo = await chegaEDrena("E quanto custa a drenagem?", jobId);
    expect(novo).not.toBeNull();

    expect(await tenta(jobId, handler)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([b1, b2]);
    // O job novo roda com o dono atual (B) e com `seq` do zero: a resposta sai.
    const responde = m.createInboundTurnHandler(deps(modelo({ B: [envia("A drenagem custa 200.")] })));
    expect(await tenta(novo!, responde)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([b1, b2, "A drenagem custa 200."]);
    expect(chamadas.filter((c) => c.quem === "A")).toHaveLength(1);
  });

  it("achado 6: A enviou numa tentativa e, no retry, tenta passar: a passagem é recusada e A termina a resposta", async () => {
    const a1 = "Posso te ajudar com o agendamento.";
    const a2 = "Qual dia fica melhor?";
    const handler = m.createInboundTurnHandler(
      deps(modelo({ A: [envia(a1), "falha", passa("b"), envia(a1), envia(a2)], B: [envia("B não pode falar aqui.")] })),
    );
    const jobId = await enfileira();
    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu/);
    await canalAceita(jobId);

    expect(await tenta(jobId, handler)).toBeNull();
    expect(vistos()).toMatch(/ja_respondeu_a_esta_mensagem/);
    expect(await dono()).toEqual({ agente: A, assunto: "a" });
    expect((await decisoes(jobId)).filter((d) => d.outcome === "reclassified")).toHaveLength(0);
    expect(chamadas.filter((c) => c.quem === "B")).toHaveLength(0);
    expect(await mensagensQueSairam()).toEqual([a1, a2]);
    expect(await payloadDoJob(jobId)).not.toHaveProperty("passagem_feita");
  });

  it("caso 6c: A enviou, passou e o fechamento falhou: o retry não deixa B mandar uma segunda resposta", async () => {
    const deA = "Vou te passar para quem cuida de drenagem.";
    const handler = m.createInboundTurnHandler(
      deps(
        modelo(
          { A: [[envia(deA), passa("b")]], B: [envia("Primeira bolha de B."), envia("Segunda bolha de B.")] },
          { fechamentosQueFalham: 1 },
        ),
      ),
    );
    const jobId = await enfileira();

    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu no fechamento/);
    expect(await mensagensQueSairam()).toEqual([deA]);
    // É esta marca, e não `passagem_feita`, que encerra o retry sem modelo.
    expect(await payloadDoJob(jobId)).toMatchObject({ passagem_feita: true, passagem_com_envio_da_origem: true });

    const antesDoRetry = chamadas.length;
    expect(await tenta(jobId, handler)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([deA]);
    expect(await enviosAceitos(jobId)).toBe(1);
    expect(chamadas.filter((c) => c.quem === "B")).toHaveLength(0);
    expect(chamadas).toHaveLength(antesDoRetry);
  });

  it("caso 6d: A enviou num passo, passou no seguinte e o fechamento falhou: o retry não roda modelo nenhum", async () => {
    const deA = "Vou te passar para quem cuida de drenagem.";
    const handler = m.createInboundTurnHandler(
      deps(modelo({ A: [envia(deA), passa("b")], B: [envia("B não deveria falar neste turno.")] }, { fechamentosQueFalham: 1 })),
    );
    const jobId = await enfileira();

    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu no fechamento/);
    expect(await payloadDoJob(jobId)).toMatchObject({ passagem_feita: true, passagem_com_envio_da_origem: true });
    await canalAceita(jobId);

    const antesDoRetry = chamadas.length;
    expect(await tenta(jobId, handler)).toBeNull();
    expect(chamadas).toHaveLength(antesDoRetry);
    expect(await mensagensQueSairam()).toEqual([deA]);
    expect(await dono()).toEqual({ agente: B, assunto: "b" });
  });

  it("mensagem nova durante a espera do retry de um job que já passou e enviou ganha job próprio, e B responde", async () => {
    const deA = "Vou te passar para quem cuida de drenagem.";
    const jobId = await enfileira();
    const quebra = m.createInboundTurnHandler(
      deps(modelo({ A: [[envia(deA), passa("b")]] }, { fechamentosQueFalham: 1 })),
    );
    expect((await tenta(jobId, quebra))?.message).toMatch(/modelo caiu no fechamento/);
    // O job voltou à fila esperando o retry: é o intervalo em que a pessoa escreve de novo.
    await pool.query("update job_queue set run_after = now() + interval '30 seconds' where id = $1", [jobId]);

    const m2 = await novaInbound("E quanto custa a drenagem?");
    await pool.query(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
       values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid, $3::jsonb, 'pending')`,
      [ORG, m2, JSON.stringify({ conversation_id: CONV, contact_id: CONTACT, channel_session_id: SESSION, inbound_message_id: m2 })],
    );
    const { drainTick } = await import("@/lib/agent-engine/edge/crm/drain");
    await drainTick(
      pool,
      { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 3000, reapTimeoutMs: 300_000 },
      m.createLogger(),
    );

    // Sem carona: o retry do job antigo encerra sem ler a conversa, e M2 sumiria com ele.
    const { rows: novos } = await pool.query<{ id: string }>(
      `select id from job_queue
        where organization_id = $1 and kind = 'inbound_turn' and id <> $2
          and payload->>'inbound_message_id' = $3`,
      [ORG, jobId, m2],
    );
    expect(novos).toHaveLength(1);

    // O retry do job antigo fecha sem modelo; o job de M2 roda com o dono atual (B).
    chamadas = [];
    expect(await tenta(jobId, quebra)).toBeNull();
    expect(chamadas).toHaveLength(0);
    const responde = m.createInboundTurnHandler(deps(modelo({ B: [envia("A drenagem custa 200.")] })));
    expect(await tenta(novos[0]!.id, responde)).toBeNull();
    expect(chamadas.filter((c) => c.quem !== "B")).toHaveLength(0);
    expect(await mensagensQueSairam()).toEqual([deA, "A drenagem custa 200."]);
    await pool.query("delete from event_log where organization_id = $1", [ORG]);
  });

  it("job pendente COMUM continua dando carona à mensagem seguinte (a exclusão é só de quem já passou)", async () => {
    const jobId = await enfileira();
    await pool.query("update job_queue set run_after = now() + interval '30 seconds' where id = $1", [jobId]);
    const m2 = await novaInbound("Oi, tem alguém?");
    await pool.query(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
       values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid, $3::jsonb, 'pending')`,
      [ORG, m2, JSON.stringify({ conversation_id: CONV, contact_id: CONTACT, channel_session_id: SESSION, inbound_message_id: m2 })],
    );
    const { drainTick } = await import("@/lib/agent-engine/edge/crm/drain");
    await drainTick(
      pool,
      { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 3000, reapTimeoutMs: 300_000 },
      m.createLogger(),
    );
    const { rows } = await pool.query<{ n: number; feitos: number }>(
      `select (select count(*)::int from job_queue where organization_id = $1 and kind = 'inbound_turn') as n,
              (select count(*)::int from event_log where organization_id = $1 and status = 'done'
                 and event_type = 'ai_agent.dispatch_requested' and entity_id = $2) as feitos`,
      [ORG, m2],
    );
    expect(rows[0]).toEqual({ n: 1, feitos: 1 });
    await pool.query("delete from event_log where organization_id = $1", [ORG]);
  });

  it("modo novo com `sticky: false` na config: depois da passagem a mensagem seguinte continua com B", async () => {
    await configDoRoteador({ permanencia: "agente", sticky: false, interrompe: [], min_confidence: 0.8 });
    expect((await rodaTurno({ A: [passa("b")], B: [envia("Drenagem é comigo.")] })).erro).toBeNull();

    chamadas = [];
    const { erro } = await rodaTurno({ B: [envia("Pode ser na quinta.")] }, await novaInbound("E quanto custa?"));
    expect(erro).toBeNull();
    expect(chamadas.length).toBeGreaterThan(0);
    expect(chamadas.filter((c) => c.quem !== "B")).toHaveLength(0);
    expect(await mensagensQueSairam()).toEqual(["Drenagem é comigo.", "Pode ser na quinta."]);
    expect(await dono()).toEqual({ agente: B, assunto: "b" });
  });

  it("mensagem que chega durante o turno de A entra na anotação do job antes de B responder", async () => {
    let chegou: string | null = null;
    const handler = m.createInboundTurnHandler(
      deps(
        modelo(
          { A: [passa("b")], B: [envia("Respondo às duas.")] },
          {
            aoChamar: async (quem) => {
              if (quem === "A" && chegou === null) chegou = await novaInbound("Ah, e aceita convênio?");
            },
          },
        ),
      ),
    );
    const jobId = await enfileira();
    expect(await tenta(jobId, handler)).toBeNull();

    const { rows } = await pool.query<{ coberta: boolean }>(
      `select (j.payload->>'ultima_inbound_vista_em')::timestamptz >= m.created_at as coberta
         from job_queue j, messages m where j.id = $1 and m.id = $2`,
      [jobId, chegou],
    );
    expect(rows[0]!.coberta).toBe(true);
    expect(await mensagensQueSairam()).toEqual(["Respondo às duas."]);
  });

  it("caso 6b: falha ANTES do envio (depois de gravar a passagem): o retry responde com B, uma vez", async () => {
    const handler = m.createInboundTurnHandler(
      deps(modelo({ A: [passa("b")], B: ["falha", envia("Aqui é a drenagem, posso ajudar.")] })),
    );
    const jobId = await enfileira();

    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu/);
    expect(await mensagensQueSairam()).toEqual([]);
    expect(await dono()).toEqual({ agente: B, assunto: "b" });

    expect(await tenta(jobId, handler)).toBeNull();
    expect(await mensagensQueSairam()).toEqual(["Aqui é a drenagem, posso ajudar."]);
    expect(await enviosAceitos(jobId)).toBe(1);
    expect(chamadas.filter((c) => c.quem === "A")).toHaveLength(1);
    // Uma passagem por mensagem recebida: no retry B não pode devolver a conversa.
    for (const c of comTools("B")) expect(c.tools).not.toContain("transfer_to_subject");
    // A passagem foi gravada uma vez só.
    expect((await decisoes(jobId)).filter((d) => d.outcome === "reclassified")).toHaveLength(1);
  });
});

describe("transfer_to_subject: onde a ferramenta NÃO existe", () => {
  it("caso 7: roteador sem `permanencia`: nem ferramenta nem bloco, e o resto do turno é igual", async () => {
    await rodaTurno({ A: [envia("Resposta no modo novo.")] });
    const novo = comTools("A")[0]!;

    chamadas = [];
    // Sem isto o segundo turno é pulado: o primeiro já respondeu a mesma mensagem.
    for (const t of ["send_ledger", "outbound_copies"]) {
      await pool.query(`delete from ${t} where organization_id = $1`, [ORG]);
    }
    await pool.query("update conversations set active_ai_agent_id = $2, active_intent = 'a' where id = $1", [CONV, A]);
    await configDoRoteador({ min_confidence: 0.8, sticky: true });
    await rodaTurno({ A: [passa("b"), envia("Resposta no modo de sempre.")] });
    const legado = comTools("A")[0]!;

    expect(legado.tools).not.toContain("transfer_to_subject");
    expect(legado.sistema).not.toContain("Outros assuntos deste atendimento");
    // A diferença entre os dois modos é SÓ a ferramenta e o bloco.
    expect(novo.tools.filter((t) => t !== "transfer_to_subject")).toEqual(legado.tools);
    expect(novo.sistema.length).toBeGreaterThan(legado.sistema.length);
    const bloco = novo.sistema.slice(novo.sistema.indexOf("## Outros assuntos deste atendimento"));
    expect(novo.sistema.replace(bloco, "").trimEnd()).toBe(legado.sistema.trimEnd());
    // A tentativa do modelo de chamar a ferramenta que não existe não muda o dono.
    expect(await dono()).toEqual({ agente: A, assunto: "a" });
  });

  it("caso 8: turno de follow-up não tem a ferramenta nem o bloco", async () => {
    const jobId = await enfileira("followup_turn");
    const [claimed] = await m.queue.claimJobs(pool, { workerId: "passagem", maxConcurrency: 1 });
    expect(claimed?.id).toBe(jobId);
    await m.runAgentTurn(deps(modelo({ A: [envia("Passando para saber se ficou alguma dúvida.")] })), claimed!, pool, { workerId: "passagem" }, {
      channelSessionId: SESSION,
      conversationId: CONV,
      buildOpening: ({ previous, leadState, context, notesIndexBlock }) =>
        m.buildOpeningMessage(previous, leadState, context, notesIndexBlock),
    });

    // O roteador entregou A (dono da conversa) e o modo novo está ligado: só o tipo do turno segura.
    expect(comTools("A").length).toBeGreaterThan(0);
    for (const c of comTools("A")) {
      expect(c.tools).not.toContain("transfer_to_subject");
      expect(c.sistema).not.toContain("Outros assuntos deste atendimento");
    }
  });
});

// Por último no arquivo: o handoff humano trava o contato para sempre.
describe("transfer_to_subject junto com handoff humano no mesmo passo", () => {
  it("sai só o aviso de escalação; B não é chamado e o turno de A fecha como handoff", async () => {
    const { erro } = await rodaTurno({
      A: [[{ tool: "request_human_handoff", input: { reason: "pediu uma pessoa" } }, passa("b")]],
      B: [envia("B não pode falar: a conversa foi para a equipe.")],
    });
    expect(erro).toBeNull();

    expect(chamadas.filter((c) => c.quem === "B")).toHaveLength(0);
    const saiu = await mensagensQueSairam();
    expect(saiu).toHaveLength(1);
    expect(saiu[0]).not.toMatch(/B não pode falar/);
    // Não houve reexecução: o turno de A seguiu até o fechamento dele.
    expect(chamadas.filter((c) => c.quem === "A" && c.tools.length === 0)).toHaveLength(1);
  });
});
