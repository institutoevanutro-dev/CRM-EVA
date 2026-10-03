/**
 * RESPOSTA PRONTA ANTES DA IA — spec EvaLink 2026-10-03.
 *
 * Quando o que o cliente disse desde a nossa última resposta é claramente uma
 * pergunta frequente cadastrada pela organização, a resposta cadastrada sai SEM
 * chamar modelo, pela mesma cadeia `runBeforeSend` de tudo que sai do motor —
 * o mesmo encanamento de `avisarLeadDaEscalacao`.
 *
 * ## Nunca bloqueia o atendimento
 * Desligada, sem perguntas, sinal de urgência, trava reprovada, embedding fora do
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
import {
  decidirRespostaPronta,
  textoParaComparar,
  umAssuntoSo,
} from '@/lib/respostas-prontas/casamento';

import { runBeforeSend } from '../guardrails/before-send';
import { detectUrgencySignal } from '../guardrails/sinal-de-urgencia';
import type { AvisoDeEscalacaoIds, AvisoDeEscalacaoOpts } from './aviso-de-escalacao';

export const SEQ_DA_RESPOSTA_PRONTA = -1;

export type DesfechoDaRespostaPronta =
  | { respondeu: true; respostaProntaId: string }
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
  const { rows: configs } = await pool.query<{ limite: number; tem_perguntas: boolean }>(SQL_CONFIG, [
    ids.tenantId,
    MODELO_DE_EMBEDDING,
  ]);
  const config = configs[0];
  if (config === undefined) return { respondeu: false, motivo: 'desligada' };
  if (!config.tem_perguntas) return { respondeu: false, motivo: 'sem_perguntas' };
  // Dor, sangramento, falta de ar: nunca responder com tabela de preço.
  if (opts.pendentes.some((t) => detectUrgencySignal(t))) {
    return { respondeu: false, motivo: 'sinal_de_urgencia' };
  }

  const texto = textoParaComparar(opts.pendentes);
  const forma = umAssuntoSo(texto);
  if (!forma.ok) return { respondeu: false, motivo: forma.motivo };

  let vetor: number[];
  try {
    vetor = (
      await (opts.embed ?? embedText)(texto, {
        organizationId: ids.tenantId,
        ponto: 'embedding_consultar',
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
