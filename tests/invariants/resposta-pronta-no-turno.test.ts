import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { embedText } from "@/lib/ai/embed";
import type * as RespostaPronta from "@/lib/agent-engine/agent/resposta-pronta";
import type * as Spinning from "@/lib/agent-engine/spinning/store";

import {
  AGORA,
  abrirPool,
  canalQueCaptura,
  carregarMotor,
  enfileirar,
  gravarInbound,
  montaHandler,
  recriarConversa,
  rodaTurno,
  semearBase,
  type Motor,
} from "./turno-com-postgres";

/**
 * O TURNO INTEIRO CONTRA POSTGRES DE VERDADE — a resposta pronta sai sem modelo,
 * marcada e registrada; e em TODO desvio do caminho feliz a IA responde como
 * antes. Harness em `turno-com-postgres.ts` (espelho do de
 * `handoff-avisa-o-lead.test.ts`), mais o embedding INJETADO: vetores fixos,
 * sem rede.
 *
 * "A IA respondeu" é `modeloChamado > 0`, não `=== 1`: um turno de IA de
 * verdade chama o modelo ao menos duas vezes (turno + checkpoint de
 * fechamento). O caminho da resposta pronta é ZERO chamadas e nenhuma linha em
 * `llm_calls`.
 */

const pool = abrirPool();

const ALVO = {
  org: "0306cccc-0000-4000-8000-000000000001",
  contact: "0306cccc-0000-4000-8000-000000000002",
  session: "0306cccc-0000-4000-8000-000000000003",
  conv: "0306cccc-0000-4000-8000-000000000004",
};
const ORG = ALVO.org;
const ORG_VIZINHA = "0306dddd-0000-4000-8000-000000000001";
const ITEM = "0306cccc-0000-4000-8000-000000000005";
const ITEM_VIZINHO = "0306dddd-0000-4000-8000-000000000005";
const RESPOSTA = "A limpeza (profilaxia) custa R$ 180,00 e leva cerca de 40 minutos.";
const MODELO = "openai/text-embedding-3-small";

function vetor(eixo: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[eixo] = 1;
  return v;
}
const LIMPEZA = vetor(0);
const OUTRO_ASSUNTO = vetor(2);
const literal = (v: number[]) => `[${v.join(",")}]`;

let m: Motor;
let tentarRespostaPronta: typeof RespostaPronta.tentarRespostaPronta;
let recordCopy: typeof Spinning.recordCopy;

interface Enviado {
  body: string;
  seq: number;
  metadata: Record<string, string> | undefined;
}
let enviados: Enviado[] = [];
let modeloChamado = 0;
let embedChamado = 0;
let embedFalha = false;
let aoEnviar: (() => Promise<void>) | null = null;

/** Vetor fixo por assunto: "limpeza" no texto → eixo 0; o resto → eixo 2. */
const embedFalso: typeof embedText = async (texto) => {
  embedChamado += 1;
  if (embedFalha) throw new Error("embedding fora do ar");
  return {
    embedding: texto.toLowerCase().includes("limpeza") ? LIMPEZA : OUTRO_ASSUNTO,
    promptTokens: 0,
    model: MODELO,
  };
};

/**
 * Captura o envio E grava a linha `accepted` do `send_ledger`, como o adapter
 * de verdade (`sendWithLedger`) faria — é o recibo que o replay consulta.
 */
const canal = () =>
  canalQueCaptura(async (i) => {
    enviados.push({ body: i.body, seq: i.seq, metadata: i.metadata });
    await pool.query(
      `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
       values ($1,$2,$3,$4,'h','accepted') on conflict (job_id, seq) do nothing`,
      [i.tenantId, i.leadId, i.jobId, i.seq],
    );
    if (aoEnviar) await aoEnviar();
    return enviados.length;
  });

function handlerCom(embed: typeof embedText = embedFalso) {
  return montaHandler(m, {
    aoChamarModelo: () => {
      modeloChamado += 1;
    },
    canal,
    embed,
  });
}

/** Grava os inbounds (uma rajada) e roda UM turno pinado no primeiro. */
async function rodaTurnoCom(...textos: string[]): Promise<void> {
  await rodaTurno(pool, m, ALVO, handlerCom(), textos, "pronta");
}

/** O MESMO job de novo, como depois de um crash e re-claim. */
async function reprocessaOUltimoJob(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "select id from job_queue where organization_id = $1 order by created_at desc limit 1",
    [ORG],
  );
  const jobId = rows[0]!.id;
  await pool.query("update job_queue set status = 'pending', run_after = now() where id = $1", [jobId]);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "replay", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  await handlerCom()(claimed!, pool, { workerId: "replay" });
  await m.queue.completeJob(pool, claimed!.id, "replay");
}

async function semearItem(org: string, id: string): Promise<void> {
  await pool.query(
    `insert into respostas_prontas (id, organization_id, titulo, resposta) values ($1,$2,'Preço da limpeza',$3)`,
    [id, org, RESPOSTA],
  );
  await pool.query(
    `insert into respostas_prontas_perguntas (organization_id, resposta_pronta_id, texto, embedding, modelo_embedding)
     values ($1,$2,'Quanto custa a limpeza?',$3::vector,$4)`,
    [org, id, literal(LIMPEZA), MODELO],
  );
}

async function ligar(org: string, ligado = true): Promise<void> {
  await pool.query(
    `insert into respostas_prontas_config (organization_id, ligado) values ($1,$2)
     on conflict (organization_id) do update set ligado = excluded.ligado`,
    [org, ligado],
  );
}

async function contarUsos(org = ORG): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from respostas_prontas_usos where organization_id = $1",
    [org],
  );
  return Number(rows[0]!.n);
}

const saiuARespostaPronta = () => enviados.some((e) => e.body.includes(RESPOSTA));

beforeAll(async () => {
  m = await carregarMotor();
  tentarRespostaPronta = (await import("@/lib/agent-engine/agent/resposta-pronta")).tentarRespostaPronta;
  recordCopy = (await import("@/lib/agent-engine/spinning/store")).recordCopy;
  await semearBase(pool, ALVO, "resposta-pronta-turno");
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'resposta-pronta-vizinha','Vizinha','Vizinha') on conflict (id) do nothing`,
    [ORG_VIZINHA],
  );
});

beforeEach(async () => {
  enviados = [];
  modeloChamado = 0;
  embedChamado = 0;
  embedFalha = false;
  aoEnviar = null;
  for (const t of ["respostas_prontas_usos", "respostas_prontas_perguntas", "respostas_prontas", "respostas_prontas_config"]) {
    await pool.query(`delete from ${t} where organization_id in ($1, $2)`, [ORG, ORG_VIZINHA]);
  }
  await recriarConversa(pool, ALVO, "Paciente da clínica", "+5511900000306");
  await semearItem(ORG, ITEM);
  await ligar(ORG);
});

describe("resposta pronta no turno de inbound", () => {
  it("pergunta frequente clara: sai a resposta cadastrada, sem modelo, marcada e registrada", async () => {
    await rodaTurnoCom("Oi! Quanto custa a limpeza?");
    expect(modeloChamado, "chamou o modelo numa pergunta frequente").toBe(0);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(RESPOSTA);
    expect(enviados[0]!.seq).toBe(-1);
    expect(enviados[0]!.metadata).toEqual({ resposta_pronta_id: ITEM });
    const { rows } = await pool.query<{ resposta_pronta_id: string; conversation_id: string; similaridade: number; job_id: string | null }>(
      "select resposta_pronta_id, conversation_id, similaridade, job_id from respostas_prontas_usos where organization_id = $1",
      [ORG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resposta_pronta_id).toBe(ITEM);
    expect(rows[0]!.conversation_id).toBe(ALVO.conv);
    expect(rows[0]!.similaridade).toBeCloseTo(1, 3);
    expect(rows[0]!.job_id).not.toBeNull();
    const { rows: chamadas } = await pool.query("select 1 from llm_calls where organization_id = $1", [ORG]);
    expect(chamadas, "resposta pronta não pode gravar llm_calls").toHaveLength(0);
  });

  it("desligada (o padrão de toda clínica): a IA responde e nem o embedding é calculado", async () => {
    await ligar(ORG, false);
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(modeloChamado).toBeGreaterThan(0);
    expect(embedChamado).toBe(0);
    expect(saiuARespostaPronta()).toBe(false);
    expect(await contarUsos()).toBe(0);
  });

  it("pedido de humano vem ANTES: a rajada com a pergunta frequente vira passagem, não resposta pronta", async () => {
    await rodaTurnoCom("Quanto custa a limpeza?", "preciso de falar com atendente");
    expect(saiuARespostaPronta()).toBe(false);
    expect(embedChamado).toBe(0);
    expect(await contarUsos()).toBe(0);
  });

  it("opt-out vem ANTES: 'PARAR' na rajada silencia, sem resposta pronta", async () => {
    await rodaTurnoCom("Quanto custa a limpeza?", "PARAR");
    expect(saiuARespostaPronta()).toBe(false);
    expect(embedChamado).toBe(0);
    expect(await contarUsos()).toBe(0);
  });

  it("embedding fora do ar: o turno segue para a IA, sem derrubar nada", async () => {
    embedFalha = true;
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(embedChamado, "o caso não chegou a pedir o embedding").toBeGreaterThan(0);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
    expect(await contarUsos()).toBe(0);
  });

  it("embedding que nunca responde: corta em 3s, sem retentativa, e o turno segue para a IA", async () => {
    let recebido: { abortSignal?: AbortSignal; maxRetries?: number } = {};
    // Só termina quando o sinal aborta — como o fetch do SDK de verdade.
    const embedPendurado: typeof embedText = (_texto, o) => {
      embedChamado += 1;
      recebido = { abortSignal: o.abortSignal, maxRetries: o.maxRetries };
      return new Promise((_ok, falha) => {
        o.abortSignal?.addEventListener("abort", () => falha(o.abortSignal?.reason));
      });
    };
    const inicio = Date.now();
    await rodaTurno(pool, m, ALVO, handlerCom(embedPendurado), ["Quanto custa a limpeza?"], "pronta");
    expect(embedChamado).toBeGreaterThan(0);
    expect(recebido.maxRetries).toBe(0);
    expect(recebido.abortSignal, "o atalho não passou sinal de corte").toBeDefined();
    expect(Date.now() - inicio).toBeLessThan(10_000);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
    expect(await contarUsos()).toBe(0);
  }, 20_000);

  // "a limpeza doeu é normal?" já caía na trava 3 (o "é" sem acento lê como
  // conjunção); "A limpeza doeu?" passa nas três travas e casa com a limpeza —
  // é ela que prova a guarda de sintoma.
  it.each(["A limpeza doeu?", "a limpeza doeu é normal?"])("dor depois do procedimento (%j): nem com a pergunta frequente casando sai resposta pronta", async (frase) => {
    await rodaTurnoCom(frase);
    expect(embedChamado, "sintoma não pode nem chegar ao casamento").toBe(0);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
    expect(await contarUsos()).toBe(0);
  });

  it("erro de banco dentro do atalho: o turno segue para a IA", async () => {
    // Vetor de 3 dimensões contra a coluna vector(1536): o `<=>` da consulta de
    // similaridade estoura no Postgres — erro inesperado, nunca turno derrubado.
    const embedTorto: typeof embedText = async () => {
      embedChamado += 1;
      return { embedding: [1, 0, 0], promptTokens: 0, model: MODELO };
    };
    await rodaTurno(pool, m, ALVO, handlerCom(embedTorto), ["Quanto custa a limpeza?"], "pronta");
    expect(embedChamado).toBeGreaterThan(0);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
  });

  it("assunto que não está cadastrado: a IA responde", async () => {
    await rodaTurnoCom("Vocês fazem implante?");
    expect(embedChamado).toBeGreaterThan(0);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
  });

  it("dois assuntos na mesma mensagem: nem calcula embedding", async () => {
    await rodaTurnoCom("Quanto custa a limpeza e tem horário amanhã?");
    expect(embedChamado).toBe(0);
    expect(modeloChamado).toBeGreaterThan(0);
  });

  it("só saudação: a IA cumprimenta, sem embedding", async () => {
    await rodaTurnoCom("Oi, boa tarde!");
    expect(embedChamado).toBe(0);
    expect(modeloChamado).toBeGreaterThan(0);
  });

  it("item desativado não responde, nem com o texto idêntico ao cadastrado", async () => {
    await pool.query("update respostas_prontas set ativo = false where id = $1", [ITEM]);
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
  });

  it("item de OUTRA organização não responde aqui", async () => {
    await pool.query("delete from respostas_prontas where organization_id = $1", [ORG]);
    await semearItem(ORG_VIZINHA, ITEM_VIZINHO);
    await ligar(ORG_VIZINHA);
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(modeloChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta()).toBe(false);
    expect(await contarUsos(ORG)).toBe(0);
    expect(await contarUsos(ORG_VIZINHA)).toBe(0);
  });

  it("anti-ban: com o mesmo texto já repetido na janela do número, a cadeia veta e a IA responde", async () => {
    await recordCopy(pool, ORG, ALVO.session, RESPOSTA, AGORA);
    await recordCopy(pool, ORG, ALVO.session, RESPOSTA, AGORA);
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(embedChamado).toBeGreaterThan(0);
    expect(saiuARespostaPronta(), "o spinning devia ter vetado a 3ª cópia").toBe(false);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(await contarUsos()).toBe(0);
  });

  it("registro do uso falhou DEPOIS do envio: o turno termina — a IA não responde de novo", async () => {
    // Apagar o item durante o envio faz o insert do uso violar a FK composta.
    aoEnviar = async () => {
      await pool.query("delete from respostas_prontas where id = $1", [ITEM]);
    };
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(RESPOSTA);
    expect(await contarUsos(), "o uso devia ter falhado — o caso mediu outra coisa").toBe(0);
    expect(modeloChamado, "resposta em dobro: a IA respondeu depois da resposta pronta").toBe(0);
  });

  it("mesmo job reprocessado: o uso é contado UMA vez", async () => {
    const msgId = await gravarInbound(pool, ALVO, "Quanto custa a limpeza?");
    const { job } = await enfileirar(pool, m, ALVO, msgId);
    const ids = {
      tenantId: ORG,
      leadId: ALVO.contact,
      conversationId: ALVO.conv,
      channelSessionId: ALVO.session,
      jobId: job.id,
    };
    const opts = {
      channel: canal(),
      optedOutThisTurn: false,
      now: AGORA,
      log: m.createLogger(),
      pendentes: ["Quanto custa a limpeza?"],
      embed: embedFalso,
      sleep: async () => {},
    };
    const primeira = await tentarRespostaPronta(pool, ids, opts);
    const segunda = await tentarRespostaPronta(pool, ids, opts);
    expect(primeira.respondeu).toBe(true);
    expect(segunda.respondeu).toBe(true);
    expect(enviados, "o replay reenviou a resposta pronta").toHaveLength(1);
    expect(await contarUsos()).toBe(1);
  });

  it("replay com o spinning armado no meio: nem reenvia, nem a IA responde de novo", async () => {
    await rodaTurnoCom("Quanto custa a limpeza?");
    expect(enviados).toHaveLength(1);
    // Outros pacientes receberam o mesmo texto entre o crash e o re-claim: na
    // 2ª passada a cadeia vetaria a 3ª cópia.
    await recordCopy(pool, ORG, ALVO.session, enviados[0]!.body, AGORA);
    await recordCopy(pool, ORG, ALVO.session, enviados[0]!.body, AGORA);
    await reprocessaOUltimoJob();
    expect(modeloChamado, "resposta em dobro: a IA respondeu no replay").toBe(0);
    expect(enviados).toHaveLength(1);
    expect(await contarUsos()).toBe(1);
  });

  it("replay sem o registro do uso: o ledger sozinho prova que já respondeu", async () => {
    aoEnviar = async () => {
      await pool.query("delete from respostas_prontas where id = $1", [ITEM]);
    };
    await rodaTurnoCom("Quanto custa a limpeza?");
    aoEnviar = null;
    expect(await contarUsos(), "o uso devia ter falhado — o caso mediu outra coisa").toBe(0);
    await semearItem(ORG, ITEM);
    await reprocessaOUltimoJob();
    expect(modeloChamado, "resposta em dobro: a IA respondeu no replay").toBe(0);
    expect(enviados).toHaveLength(1);
  });
});
