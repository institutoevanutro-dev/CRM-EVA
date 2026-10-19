/**
 * REPETIÇÃO NA CONVERSA — a IA não manda de novo o que acabou de mandar.
 *
 * Medido em produção (19/10/2026): o paciente responde "OK", "No aguardo", "Por
 * gentileza", às vezes três seguidos, e o agente responde a cada um com a mesma
 * frase — "Assim que eu tiver a validação do financeiro, te explico certinho como
 * seguimos, combinado?" três vezes em 2 minutos. O paciente perguntou se falava
 * com um robô. A regra do prompt ("se a pessoa só confirmou e você não tem nada
 * novo, não responda") estava lá e o modelo respondeu mesmo assim.
 *
 * O `spinningGate` não pega: ele mede o NÚMERO inteiro (blast de template entre
 * leads), veta só a partir da 3ª cópia e devolve o veto ao modelo como erro — que
 * reescreve com outras palavras e manda. Aqui a pergunta é outra: ESTA conversa
 * já recebeu da IA quase a mesma frase há pouco?
 *
 * O desfecho não é veto: é PULO SILENCIOSO. Nada sai, o `send_message` devolve
 * `ok: true` com status próprio, e o modelo é instruído a encerrar. Veto ensina a
 * reescrever, e reescrever a mesma ideia é exatamente o defeito.
 *
 * Escopo (decidido no ponto de chamada, `inbound-turn.ts`): só o texto livre do
 * modelo no `inbound_turn`. Follow-up de texto fixo, template, mídia, o turno de
 * repasse de caso e o aviso de passagem à equipe não passam por aqui.
 *
 * Comparação: Jaccard dos tokens (os mesmos `tokens`/`jaccard` do spinning) depois
 * de tirar caixa, acento, pontuação e o primeiro nome do contato — "Perfeito,
 * Chris." e "Perfeito." são a mesma frase. Mensagem com menos de `minTokens`
 * tokens normalizados nunca é pulada: um "Perfeito" ou "Combinado!" curto pode e
 * deve se repetir ao longo de uma conversa.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { jaccard, tokens } from '../spinning/engine';

export interface RepeticaoKnobs {
  /** Quanto para trás olhar. 0 = guarda desligada. */
  janelaMs: number;
  /** Jaccard ≥ isto conta como a mesma mensagem. */
  limiar: number;
  /** Candidata com menos tokens (normalizados) que isto nunca é pulada. */
  minTokens: number;
  /** Quantas falas da IA, das mais recentes, entram na comparação. */
  ultimas: number;
}

export const REPETICAO_PADRAO: RepeticaoKnobs = {
  janelaMs: 30 * 60 * 1000,
  limiar: 0.8,
  minTokens: 4,
  ultimas: 5,
};

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Caixa, acento, pontuação/emoji e o primeiro nome do contato saem. */
export function normalizarParaRepeticao(texto: string, primeiroNome: string | null): string {
  const limpo = semAcento(texto.toLowerCase()).replace(/[^a-z0-9]+/g, ' ');
  const nome = primeiroNome === null ? '' : semAcento(primeiroNome.toLowerCase()).replace(/[^a-z0-9]+/g, '');
  const palavras = limpo.split(' ').filter((p) => p.length > 0 && p !== nome);
  return palavras.join(' ');
}

/** Primeiro nome "de gente" do contato; nome vazio ou só dígitos (telefone) = nenhum. */
export function primeiroNomeDoContato(nome: string | null | undefined): string | null {
  const primeiro = (nome ?? '').trim().split(/\s+/)[0] ?? '';
  return /\p{L}/u.test(primeiro) ? primeiro : null;
}

export type DecisaoDeRepeticao = { repetida: false } | { repetida: true; similaridade: number };

/** Decisão PURA: `recentes` são os corpos das últimas falas da IA, mais recente primeiro. */
export function decidirRepeticao(input: {
  candidata: string;
  recentes: readonly string[];
  primeiroNome: string | null;
  knobs: RepeticaoKnobs;
}): DecisaoDeRepeticao {
  const { knobs, primeiroNome } = input;
  const alvo = tokens(normalizarParaRepeticao(input.candidata, primeiroNome));
  if (alvo.size < knobs.minTokens) return { repetida: false };
  let melhor = 0;
  for (const anterior of input.recentes.slice(0, knobs.ultimas)) {
    const s = jaccard(alvo, tokens(normalizarParaRepeticao(anterior, primeiroNome)));
    if (s > melhor) melhor = s;
  }
  return melhor >= knobs.limiar ? { repetida: true, similaridade: melhor } : { repetida: false };
}

/**
 * Lê as últimas falas da IA nesta conversa e decide. Falha de leitura degrada
 * ABERTO (envia): esta guarda evita constrangimento, não pode calar o atendimento.
 */
export async function repetiuNaConversa(
  pool: Pick<pg.Pool, 'query'>,
  args: {
    organizationId: string;
    conversationId: string;
    candidata: string;
    /** O job deste turno: o que ELE já mandou é retry (o ledger cuida), nunca repetição. */
    jobId?: string;
    nomeDoContato: string | null | undefined;
    agora: Date;
    knobs: RepeticaoKnobs;
    log: Logger;
  },
): Promise<DecisaoDeRepeticao> {
  const { knobs } = args;
  if (knobs.janelaMs <= 0 || knobs.ultimas <= 0) return { repetida: false };
  const primeiroNome = primeiroNomeDoContato(args.nomeDoContato);
  // Curta demais: nem consulta o banco.
  if (tokens(normalizarParaRepeticao(args.candidata, primeiroNome)).size < knobs.minTokens) {
    return { repetida: false };
  }
  try {
    const { rows } = await pool.query<{ body: string }>(
      `select m.body
         from messages m
        where m.organization_id = $1 and m.conversation_id = $2
          and m.direction = 'outbound' and m.sent_via = 'ai' and m.type = 'text'
          and m.status <> 'failed' and m.body is not null
          and m.sent_at >= $3::timestamptz
          and not exists (
            select 1 from send_ledger l
             where l.organization_id = $1 and l.job_id = $5::uuid
               and l.id::text = m.metadata->>'idempotency_key'
          )
        order by m.sent_at desc
        limit $4`,
      [
        args.organizationId,
        args.conversationId,
        new Date(args.agora.getTime() - knobs.janelaMs).toISOString(),
        knobs.ultimas,
        args.jobId ?? null,
      ],
    );
    return decidirRepeticao({
      candidata: args.candidata,
      recentes: rows.map((r) => r.body),
      primeiroNome,
      knobs,
    });
  } catch (err) {
    args.log.warn('checagem de repetição na conversa falhou — enviando', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return { repetida: false };
  }
}

/** O que o modelo lê quando o envio é pulado. `ok: true`: não é erro a consertar. */
export const MENSAGEM_DE_REPETICAO =
  'Você já mandou quase esta mesma mensagem nesta conversa há pouco; ela NÃO foi enviada de novo. ' +
  'Não reenvie nem reformule a mesma ideia. Se a pessoa só confirmou (ok, aguardo, por gentileza), ' +
  'encerre o turno sem responder. Só chame send_message se tiver algo NOVO a dizer.';
