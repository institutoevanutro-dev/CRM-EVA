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
    const { erro, jobId } = await rodaTurno({
      A: [[envia("Vou te passar para quem cuida de drenagem."), passa("b")]],
      B: [envia("B não deveria falar neste turno.")],
    });
    expect(erro).toBeNull();

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
  it("caso 6: falha DEPOIS do envio aceito: o retry não envia de novo", async () => {
    const corpo = "Fazemos drenagem, quer agendar?";
    const handler = m.createInboundTurnHandler(
      deps(modelo({ A: [passa("b")], B: [envia(corpo), "falha", envia("Segunda tentativa de B, que não pode sair.")] })),
    );
    const jobId = await enfileira();

    expect((await tenta(jobId, handler))?.message).toMatch(/modelo caiu/);
    expect(await enviosAceitos(jobId)).toBe(1);

    const antesDoRetry = chamadas.length;
    expect(await tenta(jobId, handler)).toBeNull();
    expect(await enviosAceitos(jobId)).toBe(1);
    expect(await mensagensQueSairam()).toEqual([corpo]);
    expect(await dono()).toEqual({ agente: B, assunto: "b" });
    // Já passou e já enviou: o retry fecha o job sem chamar modelo nenhum.
    expect(chamadas).toHaveLength(antesDoRetry);
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

    const antesDoRetry = chamadas.length;
    expect(await tenta(jobId, handler)).toBeNull();
    expect(await mensagensQueSairam()).toEqual([deA]);
    expect(await enviosAceitos(jobId)).toBe(1);
    expect(chamadas.filter((c) => c.quem === "B")).toHaveLength(0);
    expect(chamadas).toHaveLength(antesDoRetry);
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
