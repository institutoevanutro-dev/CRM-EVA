/**
 * ROBÔ DO OUTRO LADO — o disjuntor determinístico do laço bot-com-bot.
 *
 * ## O incidente (produção, 16/10/2026 08:06–08:13 BRT, canal de WhatsApp)
 *
 * O número de um contato era um chatbot de farmacêutica. Ele respondia toda
 * mensagem da IA com o MESMO texto pronto ("não consegui entender a sua
 * resposta…"), às vezes duas vezes seguidas. O agente respondeu a cada uma:
 * 37 mensagens da IA e 38 recebidas em 7 minutos. Nada no turno olhava para
 * isso — o pedido de humano, o opt-out e a resposta pronta leem só o TEXTO de
 * cada mensagem, e o texto do robô não casa com nenhum deles. O laço parou
 * quando uma passagem ao humano enfim aconteceu, pelo juízo do modelo, e não
 * por regra nenhuma. Bot conversando com bot é gatilho de ban no WhatsApp e é
 * custo de modelo por mensagem.
 *
 * ## As duas assinaturas, e por que estes números
 *
 * A. **Mesma mensagem recebida N vezes na janela** (padrão 3 em 10 min).
 *    Texto normalizado (`normalizeCopy`, a mesma régua do spinning) igual ou
 *    quase igual (Jaccard de palavras ≥ 0,9) à ÚLTIMA recebida. Só conta texto
 *    com pelo menos `MIN_CARACTERES` caracteres: uma pessoa repete "oi", "ok",
 *    "sim" — um robô repete parágrafo. Três, e não dois: a pessoa que manda a
 *    mesma pergunta duas vezes porque achou que não chegou é comum; a terceira
 *    cópia idêntica de um texto longo em dez minutos não é.
 *
 * B. **Rajada da IA sem nenhuma pessoa da equipe** (padrão: mais de 20 envios
 *    `sent_via='ai'` em 5 min, e zero envio humano na mesma janela). Pega o
 *    robô cujo texto varia (protocolo, hora). O número é alto de propósito:
 *    um turno pode mandar até `MAX_SENDS_PER_TURN` (3) bolhas, e uma pessoa
 *    rápida troca 5–7 mensagens em 5 min — 6, o número sugerido no incidente,
 *    calaria conversa real. No incidente o ritmo foi ~26 envios por 5 min.
 *
 * ## O corte da janela
 *
 * A janela começa no que for mais recente: `agora - janela` ou
 * `conversations.last_handoff_at`. Assim, quando a equipe devolve a conversa à
 * IA, as cópias que dispararam a passagem não a disparam de novo.
 *
 * ## O que acontece quando dispara
 *
 * O MESMO mecanismo do opt-out e do pedido de humano (`performHumanHandoff`):
 * `force_human`, `bot_silenced_until='infinity'`, follow-ups cancelados e UM
 * aviso `handoff` na Central (dedup por episódio aberto). Diferente deles, NÃO
 * avisa o contato: do outro lado é (provavelmente) um robô, e mais uma
 * mensagem é mais uma volta do laço.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { jaccard, normalizeCopy, tokens } from '../spinning/engine';
import { isLeadInHandoff, performHumanHandoff } from './human-handoff';

export interface RoboKnobs {
  repeticoes: number;
  janelaRepeticaoMs: number;
  rajadaIaMax: number;
  janelaRajadaMs: number;
}

/** Defaults — os mesmos de `lib/agent-engine/env.ts` (BOT_LOOP_*). */
export const ROBO_KNOBS_PADRAO: RoboKnobs = {
  repeticoes: 3,
  janelaRepeticaoMs: 10 * 60_000,
  rajadaIaMax: 20,
  janelaRajadaMs: 5 * 60_000,
};

/** Abaixo disto, repetir é coisa de gente ("oi", "ok", "sim, pode ser"). */
export const MIN_CARACTERES = 20;
const SIMILARIDADE_MINIMA = 0.9;

/** Envio de PESSOA da equipe (tela, API de usuário, celular). */
const ENVIO_HUMANO = new Set(['crm', 'user', 'external_device']);

export interface MensagemRecente {
  direction: 'inbound' | 'outbound';
  sent_via: string;
  body: string | null;
  sent_at: Date;
}

export type SinalDeRobo =
  | { robo: false }
  | { robo: true; sinal: 'inbound_repetido' | 'rajada_da_ia'; contagem: number };

export function detectarRoboDoOutroLado(
  mensagens: readonly MensagemRecente[],
  agora: Date,
  knobs: RoboKnobs = ROBO_KNOBS_PADRAO,
): SinalDeRobo {
  const desde = (ms: number) => mensagens.filter((m) => m.sent_at.getTime() >= agora.getTime() - ms);

  // A — a última recebida, repetida.
  const recebidas = desde(knobs.janelaRepeticaoMs)
    .filter((m) => m.direction === 'inbound')
    .map((m) => normalizeCopy(m.body ?? ''))
    .filter((t) => t.length >= MIN_CARACTERES);
  const ultimaRecebida = [...mensagens]
    .filter((m) => m.direction === 'inbound')
    .sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())[0];
  const alvo = normalizeCopy(ultimaRecebida?.body ?? '');
  if (alvo.length >= MIN_CARACTERES) {
    const alvoTokens = tokens(alvo);
    const iguais = recebidas.filter((t) => t === alvo || jaccard(alvoTokens, tokens(t)) >= SIMILARIDADE_MINIMA).length;
    if (iguais >= knobs.repeticoes) return { robo: true, sinal: 'inbound_repetido', contagem: iguais };
  }

  // B — a IA falando sozinha com alguém que responde rápido demais.
  const janelaB = desde(knobs.janelaRajadaMs).filter((m) => m.direction === 'outbound');
  const daIa = janelaB.filter((m) => m.sent_via === 'ai').length;
  const humano = janelaB.some((m) => ENVIO_HUMANO.has(m.sent_via));
  if (!humano && daIa > knobs.rajadaIaMax) return { robo: true, sinal: 'rajada_da_ia', contagem: daIa };

  return { robo: false };
}

export const TITULO_DO_AVISO_DE_ROBO =
  'Possível robô do outro lado — a IA parou de responder; se for uma pessoa, devolva a conversa à IA';

/**
 * Lê a janela, decide e, se for robô, silencia pelo caminho do handoff. `true`
 * = turno encerrado sem resposta. Falha de leitura degrada ABERTO (o turno
 * segue): este disjuntor é proteção extra, não pode calar o atendimento.
 */
export async function pararSeForRoboDoOutroLado(
  pool: pg.Pool,
  ids: { tenantId: string; leadId: string; conversationId: string },
  opts: { agora: Date; knobs?: RoboKnobs; log: Logger },
): Promise<boolean> {
  const knobs = opts.knobs ?? ROBO_KNOBS_PADRAO;
  let sinal: SinalDeRobo;
  try {
    const janelaMs = Math.max(knobs.janelaRepeticaoMs, knobs.janelaRajadaMs);
    const { rows } = await pool.query<MensagemRecente>(
      `select m.direction, m.sent_via, m.body, m.sent_at
         from messages m
         join conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
        where m.organization_id = $1 and m.conversation_id = $2
          and m.sent_at >= greatest($3::timestamptz, coalesce(c.last_handoff_at, '-infinity'::timestamptz))
        order by m.sent_at desc
        limit 200`,
      [ids.tenantId, ids.conversationId, new Date(opts.agora.getTime() - janelaMs).toISOString()],
    );
    sinal = detectarRoboDoOutroLado(
      rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at) })),
      opts.agora,
      knobs,
    );
  } catch (err) {
    opts.log.warn('checagem de robô do outro lado falhou — seguindo', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return false;
  }
  if (!sinal.robo) return false;
  // Já em handoff: nada a fazer, e não reabrir aviso que a equipe fechou.
  if (await isLeadInHandoff(pool, ids.tenantId, ids.leadId)) return true;

  const porque =
    sinal.sinal === 'inbound_repetido'
      ? `o contato mandou a mesma mensagem ${sinal.contagem}x em ${Math.round(knobs.janelaRepeticaoMs / 60_000)} min`
      : `a IA mandou ${sinal.contagem} mensagens em ${Math.round(knobs.janelaRajadaMs / 60_000)} min sem nenhuma pessoa da equipe na conversa`;
  await performHumanHandoff(pool, ids, {
    reason: 'suspected_bot_loop',
    inboxTitle: TITULO_DO_AVISO_DE_ROBO,
    conversationSummary:
      `Detecção automática: ${porque} — assinatura de resposta automática. ` +
      'A IA parou de responder e o contato NÃO foi avisado. Se for uma pessoa, devolva a conversa à IA.',
    log: opts.log,
  });
  opts.log.info('possível robô do outro lado — bot silenciado sem resposta e escalado ao humano', {
    sinal: sinal.sinal,
    contagem: sinal.contagem,
  });
  return true;
}
