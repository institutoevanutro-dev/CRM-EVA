import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as TurnoJaRespondido from "@/lib/agent-engine/agent/turno-ja-respondido";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A MÍDIA QUE CHEGA DEPOIS DE O TURNO SER ENFILEIRADO, CONTRA POSTGRES REAL
 * (#3836 e #3845 do original, porte dos PRs #3841 e #3846 adaptado ao fork).
 *
 * No fork, o handler de `inbound_turn` espera a mídia derivável pendente da
 * conversa ANTES de rotear e de anotar o que o turno viu
 * (`ultima_inbound_vista_em`), e a anotação já deixa de fora a mídia pendente
 * mais nova que o teto. Caminho de produção: job `inbound_turn` →
 * `createInboundTurnHandler` → `runAgentTurn`, com modelo fake. Quatro fatos:
 *
 *  1. SEM REGRESSÃO — a mídia que derivou durante a espera entra na anotação, e
 *     a resposta sai uma vez só. É o caso que DISCRIMINA o porte: sem a espera,
 *     a anotação deixa o áudio pendente de fora e o job dele responde de novo.
 *  2. CASO DA JANELA — o áudio que chega entre a última checagem ("nada
 *     pendente") e a anotação não é prometido por ela: a resposta escrita sem ele
 *     é descartada, e o turno dele não fica calado. Guarda o filtro da anotação
 *     feita depois da espera.
 *  3. TETO DO TURNO — a espera estourou o teto com o áudio ainda sem texto, e a
 *     pergunta já tinha mais de 120 s: sem `esperaDaMidiaNoTeto`, o teto da régua
 *     de resposta obsoleta deixaria sair a resposta que leu o áudio como
 *     `[audio]`, e o job do áudio responderia outra vez. Com um texto DEPOIS do
 *     áudio, a anotação não pode passar por cima dele. Os CONTROLES (a), (b) e
 *     (c) prendem as três condições da trava.
 *  4. TRANSCRIÇÃO ENTRE A ANOTAÇÃO E A LEITURA — o áudio que a anotação deixou
 *     de fora deriva antes de o turno ler a conversa: a anotação passa a cobrir o
 *     que o turno leu, e o turno do texto seguinte não responde de novo. Se ele
 *     deriva logo DEPOIS da leitura, o turno relê antes de prometê-lo.
 *
 * A régua `respostaFicouObsoleta` do fork só descarta quando a mensagem nova tem
 * turno próprio CONFERIDO (job pendente ou pedido de despacho na fila): os casos
 * que esperam descarte gravam o pedido de despacho, como a ingestão faz.
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
  max: 4,
});

const ORG = "eeb20000-0000-4000-8000-000000000001";
const CONTACT = "eeb20000-0000-4000-8000-000000000002";
const SESSION = "eeb20000-0000-4000-8000-000000000003";
const CONV = "eeb20000-0000-4000-8000-000000000004";

/** Mesmo teto do turno vizinho (`resposta-descartada-tem-quem-responda`). */
const TETO = 120_000;
const PERGUNTA = "Tudo bem?";
const TRANSCRICAO = "queria saber se tem horário para limpeza de pele essa semana";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  regua: typeof TurnoJaRespondido;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados = 0;
/** O prompt da 1ª chamada do modelo, por turno — o que cada turno LEU. */
const prompts: string[] = [];

// A régua compara com `now()`, então os instantes são relativos ao relógio real.
const haSegundos = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

/** Inbound de TEXTO — o que o cliente escreve. */
async function inbound(texto: string, em: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$7,$7)`,
    [id, ORG, CONV, SESSION, CONTACT, texto, em],
  );
  return id;
}

/**
 * Inbound de ÁUDIO — `body` nulo, `media_url` presente (pré-condição de toda a
 * esteira) e derivação ainda não terminada, que é como a ingestão grava.
 */
async function audio(em: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, media_url, media_mime, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'audio','inbound','delivered',null,$6,'audio/ogg','external_device',$7,$7)`,
    [id, ORG, CONV, SESSION, CONTACT, `https://cdn.example/${id}.ogg`, em],
  );
  return id;
}

/** O worker de derivação terminou: texto pronto, status terminal. */
async function derivar(id: string): Promise<void> {
  await pool.query(
    `update messages set media_derived_status = 'ready', media_derived_text = $2 where id = $1`,
    [id, TRANSCRICAO],
  );
}

/**
 * O pedido de turno que a ingestão grava para a mensagem
 * (`ai_agent.dispatch_requested`, mesmas colunas de
 * `resposta-descartada-tem-quem-responda`): é ele que faz a régua de resposta
 * obsoleta saber que a mensagem nova tem quem responda.
 */
async function pedidoDeDespacho(messageId: string): Promise<void> {
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
             jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                'contact_id', $4::text, 'channel_session_id', $5::text,
                                'inbound_message_id', $2::text),
             'pending')`,
    [ORG, messageId, CONV, CONTACT, SESSION],
  );
}

/** Ganchos de BANCADA do pool espião — cada um roda uma vez, na primeira ocorrência. */
interface Ganchos {
  /** Imediatamente antes do UPDATE da anotação do handler. */
  antesDaAnotacao?: () => Promise<void>;
  /** Logo depois dele, antes de o turno ler a conversa. */
  depoisDaAnotacao?: () => Promise<void>;
  /** Logo depois da leitura da conversa (`getLeadContext`). */
  depoisDaLeitura?: () => Promise<void>;
}

/**
 * Pool espião — o mesmo do banco, com os `Ganchos`. É como este arquivo
 * reproduz, sem corrida, a mídia que chega no round-trip entre a última checagem
 * da espera e a anotação, e a transcrição que fica pronta antes ou depois da
 * leitura da conversa.
 */
function poolEspiao(real: pg.Pool, ganchos: Ganchos): pg.Pool {
  let anotacoes = 0;
  let leituras = 0;
  const queryOriginal = real.query.bind(real) as unknown as (
    sql: unknown,
    params?: unknown,
  ) => Promise<unknown>;
  return new Proxy(real, {
    get(alvo, prop, recv) {
      if (prop === "query") {
        return async (sql: unknown, params?: unknown) => {
          const texto = typeof sql === "string" ? sql : "";
          // `ultima_inbound_vista_em` também aparece na LEITURA da régua
          // (`ultimaInboundJaRespondida`); a anotação é o UPDATE. Os ganchos
          // valem para a PRIMEIRA, a do handler depois da espera.
          const ehAnotacao =
            texto.includes("update job_queue") && texto.includes("ultima_inbound_vista_em");
          // A leitura da conversa é a única consulta do turno que pede `media_mime`.
          const ehLeitura = texto.includes("from messages") && texto.includes("media_mime");
          if (ehAnotacao) anotacoes += 1;
          if (ehLeitura) leituras += 1;
          if (ehAnotacao && anotacoes === 1) await ganchos.antesDaAnotacao?.();
          const resultado = await queryOriginal(sql, params);
          if (ehAnotacao && anotacoes === 1) await ganchos.depoisDaAnotacao?.();
          if (ehLeitura && leituras === 1) await ganchos.depoisDaLeitura?.();
          return resultado;
        };
      }
      const valor = Reflect.get(alvo, prop, recv);
      return typeof valor === "function" ? valor.bind(alvo) : valor;
    },
  }) as pg.Pool;
}

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Modelo fake: 1ª chamada pede `send_message` (com `corpo`) e guarda o prompt em
 * `prompts`; depois encerra. `onPrimeiraChamada` roda enquanto o "modelo pensa"
 * — é a mensagem que chega durante o turno.
 */
function modelo(
  onPrimeiraChamada?: () => Promise<void>,
  corpo = "Tudo bem também! Como posso te ajudar?",
) {
  let chamadas = 0;
  return async (opts?: { prompt?: unknown }) => {
    chamadas += 1;
    if (chamadas === 1) {
      prompts.push(JSON.stringify(opts?.prompt ?? null));
      if (onPrimeiraChamada !== undefined) await onPrimeiraChamada();
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: corpo }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" }),
        },
      ],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

/**
 * Reivindica o próximo job e o roda pelo caminho de produção, com o pool espião
 * e o `sleep` do turno como gancho da derivação (sem `aoDormir`, a espera não
 * dorme e termina pelo limite de recheques).
 */
async function rodarJob(
  jobId: string,
  opcoes: Ganchos & {
    aoDormir?: () => Promise<void>;
    /** `RESPOSTA_OBSOLETA_TETO_MS` do operador (default: o de produção). */
    tetoMs?: number;
    onPrimeiraChamada?: () => Promise<void>;
    /** O que o modelo fake responde (default: a frase de sempre). */
    corpo?: string;
  } = {},
): Promise<void> {
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "midia-tardia", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "chave-de-teste" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      respostaObsoletaTetoMs: opcoes.tetoMs ?? TETO,
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
    registry: m.createFakeRegistry(modelo(opcoes.onPrimeiraChamada, opcoes.corpo) as never),
    channel: () =>
      ({
        channel: "captura",
        send: async () => {
          enviados += 1;
          return { kind: "sent" as const, idempotencyKey: `k${enviados}`, messageId: `m${enviados}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Dentro da janela anti-ban (7h-22h BRT), como os vizinhos.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {
      if (opcoes.aoDormir !== undefined) await opcoes.aoDormir();
    },
  });
  await handler(claimed!, poolEspiao(pool, opcoes), { workerId: "midia-tardia" });
  await m.queue.completeJob(pool, claimed!.id, "midia-tardia");
}

/** A anotação do turno — o carimbo que decide se o job da mídia se cala. */
async function anotacaoDoJob(jobId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ em: Date | null }>(
    `select (payload->>'ultima_inbound_vista_em')::timestamptz as em
       from job_queue where organization_id = $1 and id = $2`,
    [ORG, jobId],
  );
  return rows[0]?.em ?? null;
}

async function chegadaDe(messageId: string): Promise<Date> {
  const { rows } = await pool.query<{ em: Date }>(
    `select created_at as em from messages where id = $1`,
    [messageId],
  );
  return rows[0]!.em;
}

async function jobDoTurno(inboundMessageId: string): Promise<string> {
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: inboundMessageId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  return job.id;
}

/**
 * O envio aceito do turno `jobId`: a outbound e a linha do `send_ledger` que o
 * `sendWithLedger` de produção grava — o canal fake desta bancada não grava.
 */
async function envioAceitoDoJob(jobId: string, corpo: string): Promise<void> {
  const msgId = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','outbound','sent',$6,'ai',now(),now())`,
    [msgId, ORG, CONV, SESSION, CONTACT, corpo],
  );
  await pool.query(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status, crm_message_id)
     values ($1,$2,$3,1,'h','accepted',$4)`,
    [ORG, CONTACT, jobId, msgId],
  );
}

/** O turno que LERIA a mensagem mais nova está calado pela régua? */
async function turnoSeguinteCalado(): Promise<boolean> {
  return m.regua.ultimaInboundJaRespondida(pool, {
    organizationId: ORG,
    contactId: CONTACT,
    conversationId: CONV,
    jobId: crypto.randomUUID(),
  });
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    regua: await import("@/lib/agent-engine/agent/turno-ja-respondido"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'midia-tardia','Midia Tardia','Midia Tardia') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'midia-tardia-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
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
  enviados = 0;
  prompts.length = 0;
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  // Ritmo e cópia de envio são contados por número, fora das tabelas acima: o
  // envio de um caso (a mesma frase do modelo fake) acionaria o throttle e o
  // anti-cópia-em-massa do caso seguinte.
  await pool.query("delete from pacing_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Cliente de teste','+5511988887777')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

// Job deste arquivo que ficasse `running` travaria o `claimJobs` (vagas globais)
// dos arquivos seguintes.
afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("a mídia que chega depois de o turno ser enfileirado", () => {
  it("SEM REGRESSÃO: áudio que derivou durante a espera é prometido pela anotação (sem resposta dupla)", async () => {
    await inbound("Oi", haSegundos(20));
    const pergunta = await inbound(PERGUNTA, haSegundos(15));
    const audioEsperado = await audio(haSegundos(3));
    const job = await jobDoTurno(pergunta);

    let jaDerivou = false;
    await rodarJob(job, {
      aoDormir: async () => {
        if (!jaDerivou) {
          jaDerivou = true;
          await derivar(audioEsperado);
        }
      },
    });

    const anotacao = await anotacaoDoJob(job);
    expect(anotacao, "o turno não anotou o que viu").not.toBeNull();
    // O turno leu a TRANSCRIÇÃO: prometer o áudio é correto, e é o que impede o
    // job dele de responder de novo (resposta dupla). Sem a espera, a anotação
    // acontece com o áudio ainda pendente e o deixa de fora.
    expect(
      anotacao!.getTime(),
      "a anotação deixou de fora o áudio que o turno leu com texto — o job dele responderia de novo",
    ).toBeGreaterThanOrEqual((await chegadaDe(audioEsperado)).getTime());
    expect(enviados).toBe(1);
  });

  it("CASO DA JANELA: áudio entre a última checagem da espera e a anotação não é prometido por ela", async () => {
    // O cliente já mandou um áudio; o handler espera a derivação.
    await inbound("Oi", haSegundos(20));
    const pergunta = await inbound(PERGUNTA, haSegundos(15));
    const audioEsperado = await audio(haSegundos(3));
    const job = await jobDoTurno(pergunta);

    // Um SEGUNDO áudio chega exatamente no round-trip entre a última checagem
    // (que volta "nada pendente") e o UPDATE da anotação — chega antes de o
    // turno ler a conversa, e a derivação dele nem começou. A ingestão pede o
    // turno dele, como sempre.
    let tardioEm: Date | null = null;
    let tardioId = "";
    let jaDerivou = false;
    await rodarJob(job, {
      antesDaAnotacao: async () => {
        tardioEm = new Date();
        tardioId = await audio(tardioEm.toISOString());
        await pedidoDeDespacho(tardioId);
      },
      aoDormir: async () => {
        if (!jaDerivou) {
          jaDerivou = true;
          await derivar(audioEsperado);
        }
      },
    });

    // A resposta escrita sem o texto do áudio tardio não sai: o turno dele lê a
    // transcrição e responde a tudo de uma vez.
    expect(
      enviados,
      "saiu resposta escrita antes de o áudio tardio ter texto — o cliente recebe uma resposta que ignora o que acabou de mandar",
    ).toBe(0);

    expect(tardioId, "a injeção da bancada não rodou").not.toBe("");
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao).not.toBeNull();

    // A anotação promete o que o turno leu COM TEXTO (o áudio derivado durante a
    // espera) e NÃO promete o que ele leu como `[audio]` (o tardio). Prometer o
    // tardio cala o turno dele por `ultimaInboundJaRespondida`.
    expect(anotacao!.getTime(), "a anotação prometeu um áudio que o turno não leu").toBeLessThan(
      tardioEm!.getTime(),
    );
    expect(
      await turnoSeguinteCalado(),
      "o job do áudio tardio foi calado — ninguém responderia ao áudio",
    ).toBe(false);
  });

  it("TETO DO TURNO: a espera estourou o teto e a pergunta passou dos 120 s — a resposta com [audio] não sai", async () => {
    // A pergunta tem 125 s: passou do teto da régua de resposta obsoleta. O
    // áudio chegou há 3 s, tem pedido de turno e nunca deriva: a espera
    // reconsulta até o limite de recheques e termina no teto.
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    const audioId = await audio(haSegundos(3));
    await pedidoDeDespacho(audioId);
    const job = await jobDoTurno(pergunta);

    await rodarJob(job);

    // Sem `esperaDaMidiaNoTeto`, a pergunta além do teto fazia a régua liberar a
    // resposta que leu o áudio como `[audio]` — e o job do áudio responderia de
    // novo, com a transcrição.
    expect(
      enviados,
      "saiu a resposta que leu o áudio como [audio] — o job do áudio vai responder outra vez",
    ).toBe(0);
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao, "o turno não anotou o que viu").not.toBeNull();
    expect(anotacao!.getTime(), "a anotação prometeu o áudio que o turno leu como [audio]").toBeLessThan(
      (await chegadaDe(audioId)).getTime(),
    );
    expect(await turnoSeguinteCalado(), "o job do áudio foi calado — ninguém responderia a ele").toBe(
      false,
    );
  });

  it("TETO DO TURNO, TEXTO DEPOIS DO ÁUDIO: a anotação não passa por cima do áudio pendente", async () => {
    // A mesma cena, e o cliente escreve "?" DEPOIS do áudio, antes da anotação.
    // A anotação é UM carimbo ("vi tudo até aqui"): se cobrisse o "?", cobriria
    // o áudio junto. A resposta que leu o áudio como [audio] sairia, o pedido do
    // áudio é superado pelo do "?" no drain, o turno do "?" seria calado pela
    // anotação, e ninguém responderia à transcrição.
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    const audioId = await audio(haSegundos(5));
    await pedidoDeDespacho(audioId);
    await pedidoDeDespacho(await inbound("?", haSegundos(3)));
    const job = await jobDoTurno(pergunta);

    await rodarJob(job);

    expect(
      enviados,
      "saiu a resposta que leu o áudio como [audio] — e o turno do texto seguinte seria calado",
    ).toBe(0);
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao, "o turno não anotou o que viu").not.toBeNull();
    // É esta desigualdade que deixa o turno do "?" ler a transcrição: um
    // carimbo depois do áudio cala esse turno por `ultimaInboundJaRespondida`.
    expect(
      anotacao!.getTime(),
      "a anotação passou por cima do áudio que o turno leu como [audio]",
    ).toBeLessThan((await chegadaDe(audioId)).getTime());
  });

  it("TRANSCRIÇÃO ENTRE A ANOTAÇÃO E A LEITURA: a anotação cobre o que o turno leu, e o turno do \"?\" não responde de novo", async () => {
    // A pergunta tem 125 s e não há mídia pendente na espera. Entre a espera e a
    // anotação (o roteador, no fork) chegam um áudio e um "?", cada um com o seu
    // pedido de turno. A anotação para antes do áudio pendente; a transcrição
    // fica pronta logo DEPOIS dela e ANTES da leitura. O turno lê o áudio com
    // texto e o "?" e responde a tudo. Uma anotação que ficasse antes do áudio
    // deixaria o turno do "?" (o drain supera o pedido do áudio pelo dele)
    // responder outra vez ao que já foi respondido.
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    const job = await jobDoTurno(pergunta);

    let audioId = "";
    let interrogacao = "";
    await rodarJob(job, {
      antesDaAnotacao: async () => {
        audioId = await audio(new Date(Date.now() - 2).toISOString());
        await pedidoDeDespacho(audioId);
        interrogacao = await inbound("?", new Date().toISOString());
        await pedidoDeDespacho(interrogacao);
      },
      depoisDaAnotacao: async () => {
        await derivar(audioId);
      },
    });

    expect(prompts[0], "a bancada não montou a cena: o turno não leu a transcrição").toContain(
      TRANSCRICAO,
    );
    expect(enviados, "a resposta que leu tudo não saiu").toBe(1);

    // O turno do "?", com o envio do primeiro aceito e o ritmo zerado: calado.
    await envioAceitoDoJob(job, "Tudo bem também! Como posso te ajudar?");
    await pool.query("delete from pacing_ledger where organization_id = $1", [ORG]);
    await rodarJob(await jobDoTurno(interrogacao), {
      corpo: "Sobre a limpeza de pele: temos horário na quinta.",
    });
    expect(enviados, "o turno do \"?\" respondeu de novo ao que já tinha sido respondido").toBe(1);

    // O porquê: a anotação cobre o que o turno leu, o "?" inclusive.
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao, "o turno não anotou o que viu").not.toBeNull();
    expect(
      anotacao!.getTime(),
      "a anotação ficou antes do que o turno leu — o turno do \"?\" responderia de novo",
    ).toBeGreaterThanOrEqual((await chegadaDe(interrogacao)).getTime());
  });

  it("TRANSCRIÇÃO LOGO DEPOIS DA LEITURA: o turno relê antes de prometer o áudio, e responde com a transcrição", async () => {
    // A mesma cena, e a transcrição fica pronta logo DEPOIS de o turno ler a
    // conversa com o áudio como [audio]. Prometer o áudio sem reler deixaria sair
    // a resposta escrita com [audio] e calaria o turno do "?": ninguém
    // responderia à transcrição.
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    const job = await jobDoTurno(pergunta);

    let audioId = "";
    let interrogacao = "";
    await rodarJob(job, {
      antesDaAnotacao: async () => {
        audioId = await audio(new Date(Date.now() - 2).toISOString());
        await pedidoDeDespacho(audioId);
        interrogacao = await inbound("?", new Date().toISOString());
        await pedidoDeDespacho(interrogacao);
      },
      depoisDaLeitura: async () => {
        await derivar(audioId);
      },
    });

    expect(prompts[0], "a resposta foi escrita com o áudio como [audio] — o turno não releu").toContain(
      TRANSCRICAO,
    );
    expect(enviados).toBe(1);
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao, "o turno não anotou o que viu").not.toBeNull();
    expect(
      anotacao!.getTime(),
      "a anotação não cobre o que o turno releu — o turno do \"?\" responderia de novo",
    ).toBeGreaterThanOrEqual((await chegadaDe(interrogacao)).getTime());
  });

  // CONTROLES de `esperaDaMidiaNoTeto`: cada um derruba uma condição da trava
  // (cláusula c da régua, o teto 0 do operador, `recheques > 0`) e espera o
  // envio — sem eles, qualquer das três pode sumir com os gates verdes.

  it("CONTROLE (a): TETO DO TURNO sem pedido de despacho do áudio — envia, ninguém responderia depois", async () => {
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    await audio(haSegundos(3));
    const job = await jobDoTurno(pergunta);

    await rodarJob(job);

    expect(enviados, "descartou a resposta sem turno que responda depois — silêncio").toBe(1);
  });

  it("CONTROLE (b): TETO DO TURNO com a régua desligada pelo operador (teto 0) — envia", async () => {
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    const audioId = await audio(haSegundos(3));
    await pedidoDeDespacho(audioId);
    const job = await jobDoTurno(pergunta);

    await rodarJob(job, { tetoMs: 0 });

    expect(enviados, "a trava religou a régua que o operador desligou").toBe(1);
  });

  it("CONTROLE (c): mídia travada desde a chegada (recheques = 0) não liga a trava — envia", async () => {
    // A espera sai na primeira checagem, sem esperar: a pergunta não envelheceu
    // NA ESPERA, e o teto de 120 s da régua continua valendo. Sem `recheques > 0`,
    // o cliente que escreve durante cada turno teria toda resposta descartada.
    await audio(haSegundos(600));
    const pergunta = await inbound(PERGUNTA, haSegundos(125));
    const job = await jobDoTurno(pergunta);

    await rodarJob(job, {
      onPrimeiraChamada: async () => {
        await pedidoDeDespacho(await inbound("alô?", new Date().toISOString()));
      },
    });

    expect(enviados, "a mídia travada desligou o teto da régua de resposta obsoleta").toBe(1);
  });
});
