/**
 * RESPOSTA PRONTA ANTES DA IA — spec EvaLink 2026-10-03.
 *
 * Quando o que o cliente disse desde a nossa última resposta é claramente uma
 * pergunta frequente cadastrada pela organização, a resposta cadastrada sai SEM
 * chamar modelo, pela mesma cadeia `runBeforeSend` de tudo que sai do motor —
 * o mesmo encanamento de `avisarLeadDaEscalacao`.
 *
 * ## Nunca bloqueia o atendimento
 * Desligada, sem perguntas, sinal de urgência ou de sintoma, trava reprovada, embedding fora do
 * ar, veto da cadeia, canal recusando, erro inesperado: tudo devolve
 * `respondeu: false`, e o turno segue para a IA exatamente como antes. A ÚNICA
 * coisa que não devolve `false` é falha DEPOIS do envio aceito (o registro do
 * uso): ali o turno termina, porque a IA responder de novo seria resposta dobrada.
 *
 * ## Spinning ARMADO (ao contrário do aviso de escalação)
 * Resposta pronta é texto idêntico para clientes diferentes — o "template em
 * massa" que o gate persegue. Vetada, ela não vira silêncio: vira resposta da IA.
 * O anti-ban vence a taxa de acerto. O knob é `channel_knobs.spinning_knobs`.
 *
 * ## `seq` -1
 * O turno usa 1..n e o aviso de escalação usa 0. Se a resposta pronta for vetada
 * e a IA responder no mesmo job, as chaves `(job_id, seq)` do ledger não colidem.
 *
 * ## Sem camada semântica de promessa
 * Texto escrito pelo gestor, como o texto de fluxo do follow-up: não passa pela
 * classificação com LLM — e é o que mantém a promessa de não gravar `llm_calls`.
 */
import type pg from 'pg';

import { embedText } from '@/lib/ai/embed';
import { MODELO_DE_EMBEDDING } from '@/lib/ai/embeddings/chave';
import { decidirRespostaPronta, motivoParaPular, textoParaComparar } from '@/lib/respostas-prontas/casamento';

import { reconcileAcceptedSend } from '../edge/crm/send-ledger';
import { runBeforeSend } from '../guardrails/before-send';
import type { AvisoDeEscalacaoIds, AvisoDeEscalacaoOpts } from './aviso-de-escalacao';

export const SEQ_DA_RESPOSTA_PRONTA = -1;
const TEMPO_MAXIMO_DO_EMBEDDING_MS = 3000;

export type DesfechoDaRespostaPronta =
  /** `null` só no replay em que o ledger provou o envio e o uso não foi registrado. */
  | { respondeu: true; respostaProntaId: string | null }
  | { respondeu: false; motivo: string };

export type RespostaProntaOpts = Omit<AvisoDeEscalacaoOpts, 'motivo'> & {
  /** `inboundsNaoRespondidos` do turno — o que o cliente disse e ainda não respondemos. */
  pendentes: readonly string[];
  /** Testes injetam vetores fixos; produção usa `embedText`. */
  embed?: typeof embedText;
};

const SQL_CONFIG = `
  select c.limite_similaridade::float8 as limite,
         exists (
           select 1
             from respostas_prontas_perguntas p
             join respostas_prontas r
               on r.organization_id = p.organization_id and r.id = p.resposta_pronta_id
            where p.organization_id = c.organization_id
              and r.ativo
              and p.embedding is not null
              and p.modelo_embedding = $2
         ) as tem_perguntas
    from respostas_prontas_config c
   where c.organization_id = $1 and c.ligado`;

const SQL_SIMILARIDADE = `
  select r.id, r.resposta, max(1 - (p.embedding <=> $2::vector))::float8 as similaridade
    from respostas_prontas r
    join respostas_prontas_perguntas p
      on p.organization_id = r.organization_id and p.resposta_pronta_id = r.id
   where r.organization_id = $1
     and r.ativo
     and p.embedding is not null
     and p.modelo_embedding = $3
   group by r.id, r.resposta`;

/** NUNCA lança. Ver o cabeçalho. */
export async function tentarRespostaPronta(
  pool: pg.Pool,
  ids: AvisoDeEscalacaoIds,
  opts: RespostaProntaOpts,
): Promise<DesfechoDaRespostaPronta> {
  try {
    return await tentar(pool, ids, opts);
  } catch (err) {
    opts.log.warn('resposta pronta falhou — o turno segue para a IA', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
    return { respondeu: false, motivo: 'erro' };
  }
}

async function tentar(
  pool: pg.Pool,
  ids: AvisoDeEscalacaoIds,
  opts: RespostaProntaOpts,
): Promise<DesfechoDaRespostaPronta> {
  // REPLAY: este job já respondeu pronto (crash depois do envio, re-claim). Os
  // gates abaixo rodariam DE NOVO antes da dedup do ledger — o spinning, com a
  // cópia de outros pacientes no meio, vetaria, e a IA mandaria uma segunda
  // resposta num seq novo. O ledger é a prova primária (o registro do uso pode
  // ter falhado); o uso é a reserva.
  const replay = await jaRespondeuNesteJob(pool, ids);
  if (replay !== undefined) return { respondeu: true, respostaProntaId: replay };

  const { rows: configs } = await pool.query<{ limite: number; tem_perguntas: boolean }>(SQL_CONFIG, [
    ids.tenantId,
    MODELO_DE_EMBEDDING,
  ]);
  const config = configs[0];
  if (config === undefined) return { respondeu: false, motivo: 'desligada' };
  if (!config.tem_perguntas) return { respondeu: false, motivo: 'sem_perguntas' };
  // Urgência, sintoma clínico e trava 3 — antes de gastar embedding.
  const pular = motivoParaPular(opts.pendentes);
  if (pular !== null) return { respondeu: false, motivo: pular };

  const texto = textoParaComparar(opts.pendentes);

  let vetor: number[];
  try {
    vetor = (
      await (opts.embed ?? embedText)(texto, {
        organizationId: ids.tenantId,
        ponto: 'embedding_consultar',
        // O cliente está esperando: sem resposta em 3s, a IA atende.
        abortSignal: AbortSignal.timeout(TEMPO_MAXIMO_DO_EMBEDDING_MS),
        maxRetries: 0,
      })
    ).embedding;
  } catch (err) {
    opts.log.warn('resposta pronta: embedding indisponível — o turno segue para a IA', {
      error: err instanceof Error ? err.message.slice(0, 160) : 'erro desconhecido',
    });
    return { respondeu: false, motivo: 'embedding_indisponivel' };
  }

  const { rows } = await pool.query<{ id: string; resposta: string; similaridade: number }>(
    SQL_SIMILARIDADE,
    [ids.tenantId, `[${vetor.join(',')}]`, MODELO_DE_EMBEDDING],
  );
  const decisao = decidirRespostaPronta(new Map(rows.map((r) => [r.id, r.similaridade])), config.limite);
  if (!decisao.casou) return { respondeu: false, motivo: decisao.motivo };
  const item = rows.find((r) => r.id === decisao.respostaProntaId);
  if (item === undefined) return { respondeu: false, motivo: 'erro' };

  const chain = await runBeforeSend({
    pool,
    log: opts.log,
    tenantId: ids.tenantId,
    leadId: ids.leadId,
    jobId: ids.jobId,
    channelSessionId: ids.channelSessionId,
    body: item.resposta,
    optedOutThisTurn: opts.optedOutThisTurn,
    // Só roda em `inbound_turn`: responde a quem escreveu, então lê a janela de
    // RESPOSTA (0335), a mesma que deixou o turno rodar.
    resposta: true,
    crmDailyLimit: null,
    now: opts.now,
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.lgpd !== undefined ? { lgpd: opts.lgpd } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.disclosureMode !== undefined ? { disclosureMode: opts.disclosureMode } : {}),
    send: (finalBody) =>
      opts.channel.send({
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        jobId: ids.jobId,
        jobClaim: ids.jobClaim,
        seq: SEQ_DA_RESPOSTA_PRONTA,
        conversationId: ids.conversationId,
        body: finalBody,
        metadata: { resposta_pronta_id: item.id },
      }),
  });
  if (chain.status === 'vetoed') {
    opts.log.info('resposta pronta vetada pela cadeia — o turno segue para a IA', { code: chain.code });
    return { respondeu: false, motivo: `vetada:${chain.code}` };
  }
  const kind = chain.outcome.kind;
  if (kind !== 'sent' && kind !== 'already_sent' && kind !== 'queued') {
    return { respondeu: false, motivo: `canal:${kind}` };
  }

  // Daqui para baixo a mensagem JÁ saiu: nenhuma falha devolve o turno à IA.
  try {
    await pool.query(
      `insert into respostas_prontas_usos (organization_id, resposta_pronta_id, conversation_id, job_id, similaridade)
       values ($1, $2, $3, $4, $5)
       on conflict (organization_id, job_id) do nothing`,
      [ids.tenantId, item.id, ids.conversationId, ids.jobId, decisao.similaridade],
    );
  } catch (err) {
    opts.log.warn('resposta pronta enviada, mas o uso não foi registrado', {
      error: err instanceof Error ? err.message.slice(0, 160) : 'erro desconhecido',
    });
  }
  return { respondeu: true, respostaProntaId: item.id };
}

/** `undefined` = este job ainda não respondeu pronto; senão o item (ou `null` se só o ledger sabe). */
async function jaRespondeuNesteJob(
  pool: pg.Pool,
  ids: AvisoDeEscalacaoIds,
): Promise<string | null | undefined> {
  const doLedger = await reconcileAcceptedSend(pool, {
    tenantId: ids.tenantId,
    jobId: ids.jobId,
    seq: SEQ_DA_RESPOSTA_PRONTA,
  });
  const { rows } = await pool.query<{ ledger: boolean; item: string | null }>(
    `select exists (
              select 1 from send_ledger
               where organization_id = $1 and job_id = $2 and seq = $3
                 and status in ('accepted', 'queued')
            ) as ledger,
            (select resposta_pronta_id::text from respostas_prontas_usos
              where organization_id = $1 and job_id = $2) as item`,
    [ids.tenantId, ids.jobId, SEQ_DA_RESPOSTA_PRONTA],
  );
  const r = rows[0];
  if (r?.item != null) return r.item;
  return doLedger || r?.ledger === true ? null : undefined;
}
