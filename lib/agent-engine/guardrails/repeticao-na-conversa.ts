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
 * O desfecho não é veto: o texto do modelo NÃO sai, o `send_message` devolve
 * `ok: true` com status próprio, e o modelo é instruído a encerrar. Veto ensina a
 * reescrever, e reescrever a mesma ideia é exatamente o defeito.
 *
 * No lugar do texto barrado sai uma FRASE CURTA FIXA (decisão do dono, 21/10/2026:
 * silêncio depois de um "ok" também soa a robô). Fixa e configurável, nunca do
 * modelo: escrita pelo modelo, ela mesma cairia na guarda. Ela segue pela cadeia
 * inteira (opt-out, anti-ban, janela), como qualquer envio. No máximo uma por
 * conversa dentro da janela; se a IA repetir de novo nesse intervalo, a frase não
 * sai outra vez: abre caso para a equipe, porque a conversa travou num laço.
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
 *
 * DEPOIS DE UMA CONFIRMAÇÃO CURTA o limiar aperta (`limiarAposConfirmacao`, 0.5).
 * Medido em produção (23/10/2026): depois de um "Ok"/"sim" o modelo não repete a
 * frase, PARAFRASEIA — "Assim que o financeiro confirmar o comprovante, eu sigo
 * com você..." vira "Assim que o financeiro confirmar, eu sigo por aqui com
 * você...", Jaccard abaixo de 0.8. Quando o cliente só confirmou, não há pergunta
 * nova a responder, e a mesma ideia reescrita é o defeito. Confirmação = a regra
 * do cron de devolução (`ehSoDespedida`) mais "sim"/"no aguardo"/"por gentileza".
 * A última entrada do cliente é que decide: se ela é uma pergunta, vale o 0.8.
 * E só aperta se a fala anterior (a que o cliente confirmou) NÃO era pergunta de
 * verdade: "Posso marcar quinta às 10h?" → "sim" → "Pronto, marquei quinta às 10h!"
 * ecoa a pergunta e é a resposta certa. Pergunta-muleta ("..., combinado?",
 * "tudo bem?") não conta como pergunta: é o padrão do defeito.
 */
import type pg from 'pg';

import { ehSoDespedida, type UltimaEntrada } from '@/lib/escalacao/devolucao-automatica';

import type { Logger } from '../obs/logger';
import { jaccard, tokens } from '../spinning/engine';

export interface RepeticaoKnobs {
  /** Quanto para trás olhar. 0 = guarda desligada. */
  janelaMs: number;
  /** Jaccard ≥ isto conta como a mesma mensagem. */
  limiar: number;
  /** Idem, quando a última entrada do cliente é só uma confirmação curta ("ok", "sim"). Nunca afrouxa `limiar`. */
  limiarAposConfirmacao: number;
  /** Candidata com menos tokens (normalizados) que isto nunca é pulada. */
  minTokens: number;
  /** Quantas falas da IA, das mais recentes, entram na comparação. */
  ultimas: number;
  /** Frase curta que sai no lugar da repetida (variantes). Vazia = só cala, sem frase nem caso. */
  frases: readonly string[];
}

export const REPETICAO_PADRAO: RepeticaoKnobs = {
  janelaMs: 30 * 60 * 1000,
  limiar: 0.8,
  limiarAposConfirmacao: 0.5,
  minTokens: 4,
  ultimas: 5,
  frases: ['Ficou alguma dúvida sobre isso?'],
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

/** O que, além das despedidas do cron, conta como "o cliente só confirmou". Normalizado. */
const CONFIRMACOES: readonly (readonly string[])[] = [
  'sim', 'ss', 'uhum', 'aham', 'entendi', 'certinho', 'aguardo', 'no aguardo', 'fico no aguardo',
  'aguardando', 'por gentileza', 'por favor',
].map((f) => f.split(' '));

/** A última entrada do cliente é só uma confirmação/encerramento curto? Sem entrada = não. */
export function ehConfirmacaoCurta(m: UltimaEntrada | null | undefined): boolean {
  return m != null && ehSoDespedida(m, CONFIRMACOES);
}

/** A última mensagem do cliente no transcript do turno (o contexto só leva `type` em mídia: ausente = texto). */
export function ultimaEntradaDoCliente(
  mensagens: readonly { direction: string; body: string; type?: string }[],
): UltimaEntrada | null {
  for (let i = mensagens.length - 1; i >= 0; i -= 1) {
    const m = mensagens[i]!;
    if (m.direction === 'inbound') return { type: m.type ?? 'text', body: m.body };
  }
  return null;
}

/** Pergunta-muleta no fim da frase: confirma o dito, não pede decisão. Normalizada. */
const PERGUNTAS_MULETA = new Set([
  'combinado', 'tudo bem', 'ta bem', 'ok', 'ta', 'ta bom', 'certo', 'tudo certo', 'pode ser', 'beleza', 'fechado', 'ne',
]);

/**
 * A fala termina numa pergunta de verdade? Olha só a última frase, e dela o último
 * trecho entre vírgulas, sem o primeiro nome do contato: "…, combinado?" e
 * "Tudo bem, Chris? 😊" são muleta; "Posso marcar quinta às 10h?" é pergunta.
 */
export function terminaEmPerguntaReal(texto: string | null | undefined, primeiroNome: string | null = null): boolean {
  const s = (texto ?? '').replace(/[^\p{L}\p{N}?]+$/u, '');
  if (!s.endsWith('?')) return false;
  const frase = s.replace(/\?+$/, '').split(/[.!?\n]/).pop() ?? '';
  const trechos = frase
    .split(/[,;:]/)
    .map((t) => normalizarParaRepeticao(t, primeiroNome))
    .filter((t) => t !== '');
  const fim = trechos[trechos.length - 1];
  return fim !== undefined && !PERGUNTAS_MULETA.has(fim);
}

/** A última fala NOSSA antes da última entrada do cliente (a que ele respondeu). */
export function falaAntesDaEntrada(
  mensagens: readonly { direction: string; body: string }[],
): string | null {
  let i = mensagens.length - 1;
  while (i >= 0 && mensagens[i]!.direction !== 'inbound') i -= 1;
  while (i >= 0 && mensagens[i]!.direction === 'inbound') i -= 1;
  return i >= 0 ? mensagens[i]!.body : null;
}

export type DecisaoDeRepeticao = { repetida: false } | { repetida: true; similaridade: number };

/**
 * Decisão PURA: `recentes` são os corpos das últimas falas da IA, mais recente
 * primeiro; `ultimaEntrada` é a última mensagem do cliente (aperta o limiar se
 * for só confirmação).
 */
export function decidirRepeticao(input: {
  candidata: string;
  recentes: readonly string[];
  primeiroNome: string | null;
  knobs: RepeticaoKnobs;
  ultimaEntrada?: UltimaEntrada | null;
  /** A fala que o cliente confirmou; se era pergunta de verdade, o limiar não aperta. */
  falaAnterior?: string | null;
}): DecisaoDeRepeticao {
  const { knobs, primeiroNome } = input;
  const alvo = tokens(normalizarParaRepeticao(input.candidata, primeiroNome));
  if (alvo.size < knobs.minTokens) return { repetida: false };
  let melhor = 0;
  for (const anterior of input.recentes.slice(0, knobs.ultimas)) {
    const s = jaccard(alvo, tokens(normalizarParaRepeticao(anterior, primeiroNome)));
    if (s > melhor) melhor = s;
  }
  const limiar = ehConfirmacaoCurta(input.ultimaEntrada) && !terminaEmPerguntaReal(input.falaAnterior, primeiroNome)
    ? Math.min(knobs.limiar, knobs.limiarAposConfirmacao)
    : knobs.limiar;
  return melhor >= limiar ? { repetida: true, similaridade: melhor } : { repetida: false };
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
    /** Última mensagem do cliente no contexto do turno (aperta o limiar se for só "ok"). */
    ultimaEntrada?: UltimaEntrada | null;
    /** A fala que o cliente confirmou (ver `falaAntesDaEntrada`). */
    falaAnterior?: string | null;
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
      ultimaEntrada: args.ultimaEntrada ?? null,
      falaAnterior: args.falaAnterior ?? null,
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

export type SaidaDaRepeticao =
  | { acao: 'frase'; texto: string }
  | { acao: 'caso' }
  | { acao: 'silencio' };

/**
 * Decisão PURA do que fazer com a repetição barrada. `fraseJaSaiu`: alguma das
 * frases saiu da IA nesta conversa dentro da janela (`null` = a leitura falhou).
 * A variante é escolhida pela conversa, estável, para o mesmo número não mandar
 * sempre a mesma frase a conversas diferentes (o spinning do número mede isso).
 */
export function decidirSaidaDaRepeticao(input: {
  frases: readonly string[];
  fraseJaSaiu: boolean | null;
  conversationId: string;
}): SaidaDaRepeticao {
  const frases = input.frases.map((f) => f.trim()).filter((f) => f !== '');
  // Sem frase configurada, ou sem saber se ela já saiu: o comportamento antigo.
  if (frases.length === 0 || input.fraseJaSaiu === null) return { acao: 'silencio' };
  if (input.fraseJaSaiu) return { acao: 'caso' };
  let h = 0;
  for (const ch of input.conversationId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { acao: 'frase', texto: frases[h % frases.length]! };
}

/** Alguma das frases já saiu da IA nesta conversa dentro da janela? `null` se a leitura falhou. */
export async function fraseDeRepeticaoJaSaiu(
  pool: Pick<pg.Pool, 'query'>,
  args: {
    organizationId: string;
    conversationId: string;
    agora: Date;
    knobs: RepeticaoKnobs;
    log: Logger;
  },
): Promise<boolean | null> {
  const alvos = new Set(args.knobs.frases.map((f) => normalizarParaRepeticao(f, null)).filter((f) => f !== ''));
  if (alvos.size === 0) return false;
  try {
    const { rows } = await pool.query<{ body: string }>(
      `select m.body
         from messages m
        where m.organization_id = $1 and m.conversation_id = $2
          and m.direction = 'outbound' and m.sent_via = 'ai' and m.type = 'text'
          and m.status <> 'failed' and m.body is not null
          and m.sent_at >= $3::timestamptz`,
      [args.organizationId, args.conversationId, new Date(args.agora.getTime() - args.knobs.janelaMs).toISOString()],
    );
    return rows.some((r) => alvos.has(normalizarParaRepeticao(r.body, null)));
  } catch (err) {
    args.log.warn('checagem da frase de repetição falhou — o turno só cala', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return null;
  }
}

/** O que o modelo lê quando a repetição voltou e a conversa foi para a equipe. */
export const MENSAGEM_DO_CASO_DE_REPETICAO =
  'Você ia repetir de novo a mesma mensagem nesta conversa; ela NÃO foi enviada, e a conversa foi passada para a equipe. ' +
  'Encerre o turno agora, sem chamar send_message.';

/** O caso que a equipe recebe quando a IA entra em laço de repetição. */
export const CASO_DE_REPETICAO = {
  title: 'A IA estava repetindo a mesma resposta',
  summary:
    'Na mesma conversa, a IA tentou mandar de novo quase a mesma mensagem, mesmo depois da frase curta perguntando se ficou alguma dúvida. ' +
    'Nada repetido foi enviado ao cliente.',
  blocker: 'Uma pessoa precisa ler a conversa e responder o cliente.',
} as const;
