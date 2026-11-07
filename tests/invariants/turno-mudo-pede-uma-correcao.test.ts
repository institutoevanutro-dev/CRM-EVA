import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as Repeticao from "@/lib/agent-engine/guardrails/repeticao-na-conversa";

/**
 * TURNO MUDO — o turno de resposta que terminou sem mensagem ao cliente pede
 * UMA correção, pelo turno real (handler de `inbound_turn`) e o Postgres do
 * baseline.
 *
 * O caso medido (06/10/2026): o cliente mandou os dados de entrega, o agente
 * gravou o pedido e perguntou o sobrenome em TEXTO SOLTO — sem `send_message`.
 * `messages_sent: 0`, sem veto, sem descarte: o cliente ficou sem resposta.
 *
 * O modelo é um dublê roteirizado por chamada (mesmo desenho de
 * `resposta-descartada-tem-quem-responda.test.ts`); o que se mede é o motor:
 * - texto solto → a 2ª chamada leva a correção, o envio sai pela cadeia;
 * - controle: quem já enviou não recebe correção (nenhuma chamada a mais);
 * - quem insiste no silêncio recebe UMA correção, nunca um laço.
 *
 * Resposta cortada no teto de tokens (porte do upstream #2938): o `send_message`
 * pela metade não sai, e o turno que fica mudo por corte vira aviso na Central;
 * o silêncio deliberado, não.
 *
 * Veto do gate de horário (porte do upstream #3596): numa sessão com agente que tem
 * ferramenta de agenda e o modo 'barrar', "está agendada" sem marcação volta ao modelo
 * como ensino dentro do mesmo turno, e a resposta reescrita sai pela cadeia. No modo
 * 'observar' (o padrão) a mesma mensagem sai, e o trace guarda o que o gate barraria.
 *
 * Veto e correção (porte do upstream #3673): tentativa vetada que terminou em texto
 * solto ainda pede a correção; o veto que manda parar (opt-out, conversa com a
 * equipe) e o pulo silencioso da guarda de repetição, não.
 *
 * Correção barrada de novo (porte do upstream #4038): a correção que TENTOU responder
 * e levou veto outra vez vira aviso na Central; a que escolheu o silêncio, não.
 *
 * Lembrete do compromisso que o contato tem (revisão do porte do #3596): a leitura da
 * abertura, no relógio do turno, chega ao gate de horário e ao bloco do prompt.
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

const ORG = "ee0d0601-0000-4000-8000-000000000001";
const CONTACT = "ee0d0601-0000-4000-8000-000000000002";
const SESSION = "ee0d0601-0000-4000-8000-000000000003";
const CONV = "ee0d0601-0000-4000-8000-000000000004";
// Sessão COM agente que tem ferramenta de agenda — é o que ARMA o agenda_stall e o
// horario_da_agenda. Sem agente, a sessão `SESSION` deixa os dois desarmados.
const SESSION_VETO = "ee0d0601-0000-4000-8000-000000000008";
const AGENT_VETO = "ee0d0601-0000-4000-8000-000000000009";
const VERSION_VETO = "ee0d0601-0000-4000-8000-00000000000a";
const MARCA_DA_CORRECAO = "Este turno terminou SEM nenhuma mensagem ao cliente";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  repeticaoPadrao: typeof Repeticao.REPETICAO_PADRAO;
};
let m: Modules;

let enviados: string[] = [];

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviar = (body: string) => ({
  content: [
    { type: "tool-call" as const, toolCallId: `c-${Math.random()}`, toolName: "send_message", input: JSON.stringify({ body }) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
/** O mesmo envio, mas o modelo bateu no teto de tokens no meio dele. */
const cortado = (body: string) => ({ ...enviar(body), finishReason: { unified: "length" as const, raw: undefined } });
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

type Resposta = ReturnType<typeof texto> | ReturnType<typeof enviar> | ReturnType<typeof cortado>;

/** Avisos abertos na Central para a conversa do teste. */
async function avisosDaConversa(): Promise<Array<{ kind: string; title: string }>> {
  const { rows } = await pool.query<{ kind: string; title: string }>(
    `select kind, title from agent_inbox_items
      where organization_id = $1 and ref_kind = 'conversation' and ref_id = $2 and status = 'open'`,
    [ORG, CONV],
  );
  return rows;
}

/** As linhas do gate de horário em `before_send_traces` (gate, veredito e código; nunca o corpo). */
async function linhasDoHorario(): Promise<Array<{ vetoed_gate: string | null; linha: unknown }>> {
  const { rows } = await pool.query<{ vetoed_gate: string | null; linha: unknown }>(
    `select t.vetoed_gate, e as linha
       from before_send_traces t cross join lateral jsonb_array_elements(t.trace) e
      where t.organization_id = $1 and e->>'gate' = 'horario_da_agenda'
      order by t.created_at`,
    [ORG],
  );
  return rows;
}

/** Roteiro por chamada; guarda o prompt de cada uma para conferir a correção. */
function modelo(roteiro: Resposta[]) {
  const prompts: string[] = [];
  const fake = async (options: { prompt: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    return roteiro[prompts.length - 1] ?? texto(FECHAMENTO);
  };
  return { fake, prompts };
}

/**
 * Um turno de entrada. Com `conversa`, a conversa é criada na `sessao` indicada — é
 * assim que o turno roda com o agente publicado nela. `repeticao` troca os knobs da
 * guarda de repetição; `horario`, o modo do gate de horário (ausente = 'observar').
 */
async function turno(
  fake: ReturnType<typeof modelo>["fake"],
  {
    sessao = SESSION,
    conversa = CONV,
    repeticao,
    horario,
  }: {
    sessao?: string;
    conversa?: string;
    repeticao?: typeof Repeticao.REPETICAO_PADRAO;
    horario?: "observar" | "barrar";
  } = {},
): Promise<void> {
  if (conversa !== CONV) {
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false)`,
      [conversa, ORG, CONTACT, sessao],
    );
  }
  const msg = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [msg, ORG, conversa, sessao, CONTACT, "Juan Pérez, barrio Centro, portón verde, a las 12"],
  );
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: conversa,
      contact_id: CONTACT,
      channel_session_id: sessao,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "mudo", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      ...(repeticao !== undefined ? { repeticao } : {}),
      ...(horario !== undefined ? { horarioDaAgendaModo: horario } : {}),
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
    registry: m.createFakeRegistry(fake as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (input: { body: string }) => {
          enviados.push(input.body);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "mudo" });
  await m.queue.completeJob(pool, claimed!.id, "mudo");
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    repeticaoPadrao: (await import("@/lib/agent-engine/guardrails/repeticao-na-conversa")).REPETICAO_PADRAO,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'turno-mudo','Turno Mudo','Turno Mudo') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'turno-mudo-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // Agente COM ferramenta de agenda: sem ela o agenda_stall e o horario_da_agenda ficam
  // desarmados e o "está agendada" passa — aí não há veto para reproduzir.
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'turno-mudo-veto-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION_VETO, ORG],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Agente com agenda', 'system') on conflict (id) do nothing`,
    [AGENT_VETO, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, tool_ids)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published', array['crm_reschedule_appointment'])
     on conflict (id) do nothing`,
    [VERSION_VETO, ORG, AGENT_VETO, SESSION_VETO],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [
    VERSION_VETO,
    AGENT_VETO,
  ]);
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
  enviados = [];
  // Antes de `contacts`: a FK do compromisso para o contato é RESTRICT.
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente de teste','+5511900000601')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

afterAll(async () => {
  await pool.query("delete from calendar_appointments where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("o turno de resposta que terminou sem mensagem ao cliente", () => {
  it("⭐ texto solto: a 2ª chamada leva a correção e a resposta SAI para o cliente", async () => {
    const { fake, prompts } = modelo([
      texto("¿Me pasás tu apellido completo?"), // o caso medido: pergunta fora de send_message
      enviar("¿Me pasás tu apellido completo? 😊"), // a correção
      texto("listo"),
    ]);
    await turno(fake);

    expect(enviados, "o cliente ficou sem resposta depois de mandar os dados").toEqual([
      "¿Me pasás tu apellido completo? 😊",
    ]);
    expect(prompts[1], "a 2ª chamada não levou o pedido de correção").toContain(MARCA_DA_CORRECAO);
    expect(prompts[0]).not.toContain(MARCA_DA_CORRECAO);
  });

  it("controle: o turno que já enviou não recebe correção nem chamada a mais", async () => {
    const { fake, prompts } = modelo([enviar("¡Listo! Tu pedido quedó confirmado ✅"), texto("ok")]);
    await turno(fake);

    expect(enviados).toEqual(["¡Listo! Tu pedido quedó confirmado ✅"]);
    // turno (2 passos: envio + encerramento) + fechamento = 3, sem correção.
    expect(prompts).toHaveLength(3);
    expect(prompts.some((p) => p.includes(MARCA_DA_CORRECAO))).toBe(false);
  });

  it("o silêncio que insiste recebe UMA correção — nunca um laço", async () => {
    const { fake, prompts } = modelo([texto("(nada a dizer)"), texto("(continuo sem nada a dizer)")]);
    await turno(fake);

    expect(enviados).toEqual([]);
    // turno + UMA correção + fechamento.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(MARCA_DA_CORRECAO);
    // Silêncio deliberado é decisão do modelo: não vira aviso.
    expect(await avisosDaConversa()).toEqual([]);
  });

  it("⭐ resposta cortada no teto de tokens não sai, e o cliente sem resposta vira aviso na Central", async () => {
    const { fake, prompts } = modelo([
      cortado("Olá, sua consulta est"), // send_message pela metade
      cortado("Olá, sua consulta está confirm"), // a correção também cortada
    ]);
    await turno(fake);

    expect(enviados, "mensagem cortada chegou ao cliente").toEqual([]);
    expect(prompts[1]).toContain(MARCA_DA_CORRECAO);
    expect(await avisosDaConversa()).toEqual([
      { kind: "other", title: "A IA não respondeu um cliente: a resposta passou do tamanho máximo" },
    ]);
  });

  it("⭐ \"está agendada\" sem marcação: o horario_da_agenda veta, ensina e a resposta reescrita sai", async () => {
    // Porte do #3596, pela fiação real do turno. "consulta" não está entre os
    // substantivos do agenda_stall, então ele deixa passar; quem barra é o
    // horario_da_agenda, porque nada foi marcado neste turno e o contato não tem
    // compromisso nenhum. O ensino volta DENTRO do loop, e a pergunta, que não afirma
    // marcação nem oferece horário, sai pela cadeia.
    const { fake, prompts } = modelo([
      enviar("Sua consulta está agendada para 05/11 às 10h."),
      enviar("Posso agendar sua consulta para 05/11 às 10h?"),
    ]);
    await turno(fake, { sessao: SESSION_VETO, conversa: crypto.randomUUID(), horario: "barrar" });

    expect(
      enviados,
      "a confirmação sem marcação chegou ao cliente — o horario_da_agenda não estava armado ou não vetou",
    ).toEqual(["Posso agendar sua consulta para 05/11 às 10h?"]);
    expect(prompts[1], "o veto do gate de horário não voltou como ensino na chamada seguinte").toContain(
      "nada foi marcado nesta resposta",
    );
    expect(prompts[0]).not.toContain("nada foi marcado nesta resposta");
  });

  it.each([
    ["agenda_confirmou_sem_marcar", "Sua consulta está agendada para 05/11 às 10h."],
    ["horario_sem_fonte", "Tenho 05/11 às 10h ou 11h. Qual prefere?"],
  ])("⭐ modo observar (o padrão), %s: a mensagem sai, nada é vetado e o trace guarda o que barraria", async (code, body) => {
    // HORARIO_DA_AGENDA_MODO ausente = 'observar'. O mesmo texto que o modo barrar veta (caso
    // acima) sai na 1ª chamada: sem ensino, sem correção do turno mudo, sem veto no trace —
    // só a linha `observado:<código>`, que é o que se mede antes de ligar o bloqueio.
    const { fake, prompts } = modelo([enviar(body), texto("ok")]);
    await turno(fake, { sessao: SESSION_VETO, conversa: crypto.randomUUID() });

    expect(enviados, "o modo observar segurou a mensagem").toEqual([body]);
    // turno (envio + encerramento) + fechamento = 3: nenhum ensino nem correção.
    expect(prompts).toHaveLength(3);
    expect(prompts.some((p) => p.includes(MARCA_DA_CORRECAO))).toBe(false);
    expect(await linhasDoHorario()).toEqual([
      { vetoed_gate: null, linha: { gate: "horario_da_agenda", verdict: "pass", code: `observado:${code}` } },
    ]);
  });

  it("⭐ lembrete dos compromissos do contato — um que terminou há pouco e um futuro — sai sem veto", async () => {
    // A leitura da abertura (porte do #3596) cobre 24h para trás e até 50 linhas, no RELÓGIO
    // DO TURNO; o bloco do prompt mostra só o que não terminou. Sem ela no gate, o
    // `doContato` fica vazio e o lembrete leva `agenda_confirmou_sem_marcar`. O relógio do
    // `turno()` é 28/07/2026 15h em São Paulo: um compromisso acabou às 10h, o outro é dia 30.
    await pool.query(
      `insert into calendar_appointments (id, organization_id, contact_id, title, starts_at, ends_at, time_zone, status)
       values ($1,$2,$3,'Consulta que já terminou','2026-07-28T12:00:00Z','2026-07-28T13:00:00Z','America/Sao_Paulo','confirmed'),
              ($4,$2,$3,'Consulta que ainda vem','2026-07-30T12:00:00Z','2026-07-30T13:00:00Z','America/Sao_Paulo','confirmed')`,
      [crypto.randomUUID(), ORG, CONTACT, crypto.randomUUID()],
    );
    // O que os gatilhos do compromisso enfileiraram não é o turno deste teste.
    await pool.query(`update job_queue set status = 'done' where organization_id = $1 and status = 'pending'`, [ORG]);
    const lembrete =
      "Sua consulta de 28/07 às 9h está confirmada ✅. Sua consulta de 30/07 às 9h também está confirmada.";
    const { fake, prompts } = modelo([enviar(lembrete), texto("ok")]);
    // Armado: em 'observar' o lembrete sairia de qualquer jeito, e o caso não mediria nada.
    await turno(fake, { sessao: SESSION_VETO, conversa: crypto.randomUUID(), horario: "barrar" });

    expect(
      enviados,
      "o lembrete dos compromissos que o contato tem foi vetado — a leitura da abertura não chegou ao gate",
    ).toEqual([lembrete]);
    expect(prompts[0], "o compromisso futuro não entrou no bloco do prompt").toContain("Consulta que ainda vem");
    expect(prompts[0], "o compromisso que já terminou entrou no bloco do prompt").not.toContain(
      "Consulta que já terminou",
    );
  });

  it("cortada e recuperada pela correção: a resposta inteira sai e não há aviso", async () => {
    const { fake } = modelo([cortado("Olá, sua consulta est"), enviar("Olá, sua consulta está confirmada."), texto("ok")]);
    await turno(fake);

    expect(enviados).toEqual(["Olá, sua consulta está confirmada."]);
    expect(await avisosDaConversa()).toEqual([]);
  });

  it("⭐ veto + texto solto: tentativa vetada, nada entregue, a correção recupera", async () => {
    // Teste 10 do aceite do original (2026-10-25, job 217c6925): o modelo chamou
    // send_message com confirmação de agenda SEM ter chamado a ferramenta, o
    // agenda_stall vetou (o erro de ensino voltou DENTRO do loop) e ele encerrou
    // o turno em TEXTO SOLTO. Com a regra antiga (`tentativasDeEnvio === 0`) a
    // correção era suprimida e o cliente ficava sem resposta.
    const { fake, prompts } = modelo([
      enviar("Seu agendamento está confirmado para amanhã às 9h"),
      texto("(reformulo mas acabo em texto solto)"),
      enviar("Combinado! Até logo 😊"),
    ]);
    await turno(fake, { sessao: SESSION_VETO, conversa: crypto.randomUUID() });

    expect(
      enviados,
      "a confirmação passou sem veto — o agenda_stall não estava armado (fixture de agente com agenda)",
    ).toEqual(["Combinado! Até logo 😊"]);
    // O veto ensinou DENTRO do loop: a 2ª chamada do 1º run já carrega o erro.
    expect(prompts[1], "o veto não voltou como ensino na chamada seguinte").toContain("NESTE turno");
    // …e mesmo assim o turno terminou mudo — é aí que a correção precisa rodar.
    expect(
      prompts[2],
      "tentativa vetada não entregou nada: a correção do turno mudo não foi pedida",
    ).toContain(MARCA_DA_CORRECAO);
  });

  it("⭐ veto na 1ª chamada e de novo na correção: aviso na Central, em vez de calar o turno (porte do #4038)", async () => {
    // A correção QUIS responder e a cadeia barrou de novo. Antes o turno acabava sem
    // mensagem, sem aviso e sem nada na tela da equipe.
    const conversa = crypto.randomUUID();
    const { fake, prompts } = modelo([
      enviar("Seu agendamento está confirmado para amanhã às 9h"),
      texto("(reformulo mas acabo em texto solto)"),
      enviar("Seu agendamento está confirmado para amanhã às 9h"),
      texto("(de novo)"),
    ]);
    await turno(fake, { sessao: SESSION_VETO, conversa });

    expect(enviados, "a confirmação passou sem veto — o agenda_stall não estava armado").toEqual([]);
    expect(prompts[2], "a correção do turno mudo não foi pedida").toContain(MARCA_DA_CORRECAO);
    const { rows } = await pool.query<{ title: string }>(
      `select title from agent_inbox_items
        where organization_id = $1 and ref_kind = 'conversation' and ref_id = $2 and status = 'open'
          and kind <> 'capabilities_missing'`,
      [ORG, conversa],
    );
    // A fixture SESSION_VETO também abre o aviso de capacidades (kind capabilities_missing),
    // que não é deste caso.
    expect(rows).toEqual([{ title: "A IA não respondeu um cliente: as regras de segurança barraram a resposta" }]);
  });

  it("controle: veto e depois silêncio escolhido na correção não abre aviso", async () => {
    const conversa = crypto.randomUUID();
    const { fake, prompts } = modelo([
      enviar("Seu agendamento está confirmado para amanhã às 9h"),
      texto("(reformulo mas acabo em texto solto)"),
      texto("(decido não responder)"),
    ]);
    await turno(fake, { sessao: SESSION_VETO, conversa });

    expect(enviados).toEqual([]);
    expect(prompts[2]).toContain(MARCA_DA_CORRECAO);
    const { rows } = await pool.query(
      `select 1 from agent_inbox_items where organization_id = $1 and ref_kind = 'conversation' and ref_id = $2
          and kind <> 'capabilities_missing'`,
      [ORG, conversa],
    );
    expect(rows).toEqual([]);
  });

  it("⭐ veto irrevogável (opt-out) + texto solto: NÃO pede correção nem chamada extra de modelo", async () => {
    // O contraponto do caso acima: o cliente pediu para sair (is_blocked=true) e o
    // gate `stop` vetou com "encerre o turno sem tentar de novo". Pedir a correção
    // aqui mandaria o modelo chamar send_message de novo, contra o veto, e pagaria
    // uma chamada de modelo (até PASSOS_DA_CORRECAO passos, com as ferramentas de
    // escrita) por toda mensagem de opt-out.
    await pool.query(`update contacts set is_blocked = true where organization_id = $1 and id = $2`, [
      ORG,
      CONTACT,
    ]);
    const { fake, prompts } = modelo([
      enviar("Ok, você foi removido da nossa lista."),
      texto("(o envio foi vetado; encerro)"),
      // sem 3ª resposta roteirizada: a 3ª chamada é o fechamento (JSON padrão do
      // dublê); se a correção fosse pedida, ela consumiria esse lugar.
    ]);
    await turno(fake);

    expect(enviados, "mensagem saiu para um contato que pediu para sair").toEqual([]);
    expect(
      prompts.some((p) => p.includes(MARCA_DA_CORRECAO)),
      "veto irrevogável pediu a correção do turno mudo — o motor mandou tentar de novo o que o stop proíbe",
    ).toBe(false);
    // turno (2 chamadas: envio vetado + encerramento) + fechamento = 3, sem correção.
    expect(prompts).toHaveLength(3);
  });

  it("⭐ a equipe assumiu no meio do turno: o veto `conversa_com_humano` não pede correção", async () => {
    // O nome deste fork. O original lista `atendimento_com_humano`, que o gate stop
    // daqui não emite: com aquele nome, a pessoa que assumiu receberia por cima uma
    // correção com as ferramentas de escrita.
    const { fake: roteiro, prompts } = modelo([
      enviar("Já te passo os horários disponíveis."),
      texto("(o envio foi vetado; encerro)"),
    ]);
    const fake: typeof roteiro = async (options) => {
      // A pessoa assume enquanto o modelo pensa: o início do turno já passou.
      if (prompts.length === 0) {
        await pool.query(`update contacts set force_human = true where organization_id = $1 and id = $2`, [
          ORG,
          CONTACT,
        ]);
      }
      return roteiro(options);
    };
    await turno(fake);

    expect(enviados, "mensagem saiu por cima da pessoa que assumiu").toEqual([]);
    expect(
      prompts.some((p) => p.includes(MARCA_DA_CORRECAO)),
      "a conversa com a equipe recebeu a correção do turno mudo",
    ).toBe(false);
  });

  it("⭐ pulo silencioso da repetição não pede correção", async () => {
    // A guarda de repetição calou a fala (sem frase curta configurada): o turno
    // DECIDIU não falar. Antes, a tentativa de envio calava a correção de carona;
    // sem a marca do descarte, a correção mandaria reescrever a mesma ideia — a
    // paráfrase que a guarda já não reconheceria.
    const repetida =
      "Assim que eu tiver a validação do financeiro, te explico certinho como seguimos, combinado?";
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text','outbound','sent',$6,'ai',
               now() - interval '1 minute', now() - interval '1 minute')`,
      [crypto.randomUUID(), ORG, CONV, SESSION, CONTACT, repetida],
    );
    const { fake, prompts } = modelo([enviar(repetida), texto("(a guarda calou; encerro)")]);
    await turno(fake, { repeticao: { ...m.repeticaoPadrao, frases: [] } });

    expect(enviados, "a fala repetida saiu").toEqual([]);
    expect(
      prompts.some((p) => p.includes(MARCA_DA_CORRECAO)),
      "o pulo da repetição pediu a correção do turno mudo",
    ).toBe(false);
    // turno (2 chamadas: envio pulado + encerramento) + fechamento = 3, sem correção.
    expect(prompts).toHaveLength(3);
  });
});
