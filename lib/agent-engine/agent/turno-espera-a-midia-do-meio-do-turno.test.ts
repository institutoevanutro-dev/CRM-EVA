/**
 * O ÁUDIO QUE CHEGA DEPOIS DE O TURNO SER ENFILEIRADO (#3836 do original, porte
 * dos PRs #3841 e #3846 adaptado ao fork).
 *
 * Relato do original: o cliente escreve "bom dia" e o turno começa; meio minuto
 * depois chegam dois áudios; o agente responde "recebi o seu áudio, mas não
 * consegui ouvir o conteúdo" — e segundos depois a transcrição dos DOIS estava
 * pronta.
 *
 * A espera do drain (`lib/agent-engine/edge/crm/drain.ts`) vale para a mídia que
 * já está na conversa quando o turno é DESPACHADO. A que chega DEPOIS disso
 * entrava no prompt como o marcador `[audio]`, e o modelo só podia dizer que não
 * ouviu.
 *
 * Este arquivo roda o handler REAL de `inbound_turn` (`createInboundTurnHandler`
 * → `runAgentTurn`, com `getLeadContext` real e o corpo composto por
 * `corpoDaMensagem`) e mede o que o PROMPT recebe e em que ORDEM as peças rodam.
 * No fork a espera mora no handler, ANTES do roteador e da anotação — o roteador
 * lê a inbound mais nova e áudio sem transcrição não é sinal nenhum para ele —, e
 * não dentro do turno, como no original.
 *
 * O ponto de parada de todos os casos de turno é a primeira chamada de modelo
 * (org sem config de LLM), o mesmo de `filtro-de-palavra-chave-no-turno`: chegar
 * ali prova que o turno atravessou a abertura com o contexto já composto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Cada contexto que o turno recebeu — é o material do PROMPT. */
  contextos: [] as unknown[],
  /** A linha do tempo do caso em curso: o pool e o roteador escrevem nela. */
  eventos: [] as string[],
  /** O agente que o roteador "escolhe" — o mesmo de `filtro-de-palavra-chave-no-turno`. */
  agente: {
    config: {
      agentId: "agente-1",
      versionId: "v1",
      operationMode: "automatic",
      pausedAt: null,
      systemPrompt: "persona",
      toolIds: [],
      casesEnabled: false,
      historyMessageWindow: 20,
      historyTokenWindow: 1000,
      handoffKeywords: [],
      filtroDePalavraChave: null,
    },
    routerId: null,
    intentName: null,
    confidence: null,
    outcome: "fallback",
  },
}));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", async (importOriginal) => {
  const real = (await importOriginal()) as unknown as {
    getLeadContext: (...args: never[]) => Promise<unknown>;
  } & Record<string, unknown>;
  return {
    ...real,
    getLeadContext: async (...args: never[]) => {
      const resultado = await real.getLeadContext(...args);
      mocks.contextos.push(resultado);
      return resultado;
    },
  };
});

// O roteador é dublado só para MARCAR quando roda: a ordem espera → roteador é
// o que este arquivo prende (o roteador real lê a inbound mais nova sozinho).
vi.mock("@/lib/agent-engine/agent/resolve-turn-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConversationTurn: async () => {
    mocks.eventos.push("roteou");
    return mocks.agente;
  },
}));

// Só os EFEITOS do handoff são dublados (CRM da Central, aviso pelo canal,
// crons), como em `filtro-de-palavra-chave-no-turno`.
vi.mock("@/lib/agent-engine/agent/human-handoff", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: vi.fn(async () => false),
  performHumanHandoff: vi.fn(),
}));
vi.mock("@/lib/agent-engine/agent/aviso-de-escalacao", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadDaEscalacao: vi.fn(async () => ({ avisado: true })),
}));
vi.mock("@/lib/agent-engine/cron/scheduler", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelPendingCronsForLead: vi.fn(async () => 0),
}));

import { corpoDaMensagem } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { createInboundTurnHandler } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";
const EVENTO = "77777777-7777-4777-8777-777777777777";

/**
 * O relógio do turno, num dia de semana dentro da janela anti-ban (15:33:40Z =
 * 12:33 BRT): com o relógio real o caso reprovaria à noite, com o turno
 * reagendado antes de abrir.
 */
const INICIO = Date.UTC(2026, 9, 6, 15, 33, 40);

const TRANSCRICAO_1 = "queria saber se tem horário para limpeza de pele essa semana";
const TRANSCRICAO_2 = "pode ser quinta à tarde";

interface Linha {
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: Date;
}

function texto(direction: Linha["direction"], body: string, emMs: number): Linha {
  return {
    direction,
    type: "text",
    body,
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date(INICIO + emMs),
  };
}

/** Áudio como o ingest grava: `body` NULL, conteúdo só no derivado (que ainda não veio). */
function audio(emMs: number, id: string): Linha {
  return {
    direction: "inbound",
    type: "audio",
    body: null,
    media_url: `https://cdn.example/${id}.ogg`,
    media_storage_path: null,
    media_mime: "audio/ogg",
    media_derived_text: null,
    sent_at: new Date(INICIO + emMs),
  };
}

const LINHA_DO_CONTATO = {
  name: "Cliente",
  display_name: null,
  email: null,
  phone_number: "5511999999999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  source: "whatsapp",
  consent: null,
  is_anonymized: false,
};

interface Estado {
  /** Quantas consultas de mídia pendente a espera já fez. */
  consultasDeMidia: number;
  /** Na Nª consulta a derivação "termina" (o worker grava `ready` + o texto). */
  prontaNaConsulta: number;
  fixada: Linha;
  linhas: () => Linha[];
  /** Idade da mídia pendente, em ms — é a âncora do teto. */
  idadeDaMidiaMs: number;
  /** Ordem dos fatos: cada consulta da espera, o roteador, a anotação, a leitura. */
  eventos: string[];
}

/**
 * Pool fingido com o formato de CADA consulta que o handler e a abertura fazem —
 * o mesmo molde de `tests/unit/filtro-de-palavra-chave-no-turno.test.ts`, mais a
 * consulta de mídia derivável e a anotação, que é o que este arquivo mede.
 */
function poolDoTurno(estado: Estado) {
  const query = vi.fn(async (sql: string) => {
    // A ANOTAÇÃO vem primeiro: a do fork cita `media_derived_status` (só promete
    // a mídia que o turno pode ler) e, sem esta ordem, a checagem abaixo a
    // confundiria com a consulta da espera.
    if (/update job_queue/.test(sql) && sql.includes("ultima_inbound_vista_em")) {
      estado.eventos.push("anotou");
      return { rows: [] };
    }
    // A consulta da ESPERA — a única SELECT que pergunta pelo estado da derivação.
    if (sql.includes("media_derived_status")) {
      estado.consultasDeMidia += 1;
      estado.eventos.push("checou-midia");
      if (estado.consultasDeMidia >= estado.prontaNaConsulta) {
        estado.eventos.push("midia-pronta");
        return { rows: [] };
      }
      return {
        rows: [
          {
            type: "audio",
            media_derived_status: "pending",
            // `Date`, como o driver `pg` devolve `timestamptz`.
            quando: new Date(Date.now() - estado.idadeDaMidiaMs),
          },
        ],
      };
    }
    if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
      return { rows: [LINHA_DO_CONTATO] };
    }
    if (sql.includes("from messages") && /and id = \$3/.test(sql)) {
      return { rows: [estado.fixada] };
    }
    if (sql.includes("from messages") && sql.includes("media_mime")) {
      estado.eventos.push("leu");
      // O produtor pede DESC e inverte — devolve DESC, como o banco.
      return { rows: [...estado.linhas()].reverse() };
    }
    if (sql.includes("playbook_pointers")) {
      return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
    }
    return { rows: [] };
  });
  return { query } as never;
}

function logFalso() {
  const info = vi.fn();
  const warn = vi.fn();
  return {
    info,
    warn,
    error: vi.fn(),
    frases: () => [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])),
    avisos: () => warn.mock.calls.map((c) => String(c[0])),
  };
}

/** O handler REAL, que para na primeira chamada de modelo (org sem config de LLM). */
async function turno(
  estado: Estado,
  log: ReturnType<typeof logFalso>,
  dormir: (ms: number) => Promise<void>,
): Promise<void> {
  mocks.eventos = estado.eventos;
  const job = {
    id: JOB,
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "inbound_turn",
    payload: {
      conversation_id: CONVERSA,
      contact_id: CONTATO,
      channel_session_id: CANAL,
      inbound_message_id: MENSAGEM,
      crm_event_id: EVENTO,
    },
    attempts: 1,
    claimed_by: "w",
    claimed_at: new Date(),
  };
  const deps = {
    log,
    llmCfg: {},
    crmCfg: {},
    knobs: { maxSteps: 1 },
    clock: () => new Date(INICIO),
    sleep: dormir,
    channel: () => ({ send: vi.fn(async () => ({ kind: "sent" })) }),
  };
  await createInboundTurnHandler(deps as never)(job as never, poolDoTurno(estado), {
    workerId: "w",
  });
}

/** A última mensagem do CLIENTE no contexto que o turno montou — o que o modelo lê. */
function ultimaInboundNoPrompt(): { body: string } {
  const contexto = mocks.contextos.at(-1) as
    | { ok: true; context: { messages: { direction: string; body: string }[] } }
    | undefined;
  expect(contexto?.ok, "o turno não chegou a montar contexto").toBe(true);
  const ultima = contexto!.context.messages.findLast((m) => m.direction === "inbound");
  expect(ultima, "o contexto não tem mensagem do cliente").toBeDefined();
  return ultima!;
}

/** O caso do relato: o "bom dia" dispara o turno e os dois áudios chegam depois. */
function estadoDoRelato(): Estado {
  const bomDia = texto("inbound", "bom dia", 0);
  return {
    consultasDeMidia: 0,
    // Terceira consulta: a derivação termina, como no relato (segundos depois).
    prontaNaConsulta: 3,
    fixada: bomDia,
    idadeDaMidiaMs: 30_000,
    eventos: [],
    linhas: () => [
      texto("outbound", "Oi! Como posso ajudar?", -20_000),
      bomDia,
      audio(30_000, "audio-1"),
      audio(37_000, "audio-2"),
    ],
  };
}

afterEach(() => {
  mocks.contextos.length = 0;
  vi.clearAllMocks();
});

describe("#3836 do original — áudio que chega depois de o turno ser enfileirado", () => {
  it("(guarda da fixture) sem transcrição o prompt receberia o marcador [audio]", () => {
    // É ESTE o material que fazia o modelo responder "não consegui ouvir": sem
    // derivado, `corpoDaMensagem` compõe o marcador, e o prompt não tem o texto.
    const semDerivado = audio(30_000, "audio-1");
    expect(corpoDaMensagem(semDerivado)).toBe("[audio]");
    const comDerivado = { ...semDerivado, media_derived_text: TRANSCRICAO_1 };
    expect(corpoDaMensagem(comDerivado)).toContain(TRANSCRICAO_1);
  });

  it("o handler espera a derivação e o prompt leva a TRANSCRIÇÃO, nunca [audio]", async () => {
    const estado = estadoDoRelato();
    // A derivação "termina" na terceira consulta: o histórico só pode ser lido
    // com o texto pronto.
    estado.linhas = () => {
      const pronta = estado.consultasDeMidia >= estado.prontaNaConsulta;
      return [
        texto("outbound", "Oi! Como posso ajudar?", -20_000),
        texto("inbound", "bom dia", 0),
        { ...audio(30_000, "audio-1"), media_derived_text: pronta ? TRANSCRICAO_1 : null },
        { ...audio(37_000, "audio-2"), media_derived_text: pronta ? TRANSCRICAO_2 : null },
      ];
    };
    const dormir = vi.fn(async () => {});

    await expect(turno(estado, logFalso(), dormir)).rejects.toThrow(/config LLM/);

    const ultima = ultimaInboundNoPrompt();
    expect(ultima.body).toContain(TRANSCRICAO_2);
    expect(ultima.body).not.toContain("[audio]");
    // E a espera ACONTECEU: sem consultar de novo, o histórico sairia antes de a
    // derivação terminar (é o defeito, e é o que este caso reprova).
    expect(estado.consultasDeMidia).toBeGreaterThanOrEqual(3);
    expect(dormir).toHaveBeenCalled();
  });

  it("a espera vem ANTES do roteador, da anotação e da leitura da conversa", async () => {
    // O roteador lê a inbound mais nova: rodando antes da espera, o áudio sem
    // transcrição não seria sinal nenhum e o agente do texto responderia a ele.
    // A anotação já deixa de fora a mídia pendente: feita depois da espera, ela
    // promete exatamente o que o turno lê.
    const estado = estadoDoRelato();

    await expect(turno(estado, logFalso(), vi.fn(async () => {}))).rejects.toThrow(/config LLM/);

    const ev = estado.eventos;
    expect(ev.indexOf("midia-pronta"), "a espera não terminou").toBeGreaterThan(-1);
    expect(ev.indexOf("midia-pronta"), "o roteador rodou antes do fim da espera").toBeLessThan(
      ev.indexOf("roteou"),
    );
    expect(ev.indexOf("roteou"), "a anotação veio antes do roteador").toBeLessThan(ev.indexOf("anotou"));
    expect(ev.indexOf("anotou"), "a conversa foi lida antes da anotação").toBeLessThan(ev.indexOf("leu"));
  });

  it("sem mídia pendente não há espera, e a anotação é uma só", async () => {
    const estado = estadoDoRelato();
    estado.prontaNaConsulta = 1;
    const dormir = vi.fn(async () => {});

    await expect(turno(estado, logFalso(), dormir)).rejects.toThrow(/config LLM/);

    expect(dormir).not.toHaveBeenCalled();
    expect(estado.eventos.filter((e) => e === "anotou")).toHaveLength(1);
  });

  it("a espera estourou o teto: o turno segue com [audio], anotando uma vez, depois da espera", async () => {
    // O áudio chegou e não derivou dentro da espera: este turno o lê como
    // `[audio]`, e o desfecho é nomeado no log. A anotação (filtrada) deixa o
    // áudio pendente de fora — o job dele ainda responde por ele.
    const estado = estadoDoRelato();
    estado.prontaNaConsulta = Number.POSITIVE_INFINITY;
    const dormir = vi.fn(async () => {});
    const log = logFalso();

    await expect(turno(estado, log, dormir)).rejects.toThrow(/config LLM/);

    expect(dormir).toHaveBeenCalled();
    expect(log.avisos().some((f) => f.includes("não derivou dentro do teto da espera"))).toBe(true);
    expect(estado.eventos.filter((e) => e === "anotou")).toHaveLength(1);
    expect(estado.eventos.lastIndexOf("checou-midia"), "anotou antes de a espera acabar").toBeLessThan(
      estado.eventos.indexOf("anotou"),
    );
    expect(ultimaInboundNoPrompt().body).toBe("[audio]");
  });

  it("mídia travada além do teto: o turno segue EM TEMPO e o desfecho é nomeado", async () => {
    // Mídia que já passou do teto de espera na chegada: esperar por ela é
    // segurar o cliente por uma derivação que não é deste turno.
    const estado = estadoDoRelato();
    estado.prontaNaConsulta = Number.POSITIVE_INFINITY;
    estado.idadeDaMidiaMs = 600_000;
    const dormir = vi.fn(async () => {});
    const log = logFalso();
    const comecou = Date.now();

    await expect(turno(estado, log, dormir)).rejects.toThrow(/config LLM/);

    // Não dormiu nada: o turno terminou em tempo.
    expect(dormir).not.toHaveBeenCalled();
    expect(Date.now() - comecou).toBeLessThan(5_000);
    // E o desfecho não é silencioso: o log diz que a espera foi recusada.
    expect(log.frases().some((f) => f.includes("teto da espera"))).toBe(true);
    // O prompt segue com o marcador — a mídia NÃO está transcrita mesmo, e é
    // sobre isso que a resposta tem de ser honesta.
    expect(ultimaInboundNoPrompt().body).toBe("[audio]");
  });
});
