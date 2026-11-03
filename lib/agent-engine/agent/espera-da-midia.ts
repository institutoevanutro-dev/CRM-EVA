/**
 * A ESPERA PELA MÍDIA QUE CHEGA DEPOIS DE O TURNO SER ENFILEIRADO (#3836 do original).
 *
 * O drain (`../edge/crm/drain.ts`) já segura o DESPACHO enquanto há mídia
 * derivável pendente na conversa. Isso cobre o áudio que já estava lá quando o
 * turno foi enfileirado — e só isso. O relato do original (01/11/2026) é o outro
 * lado da janela: às 09:33:40 o cliente escreve "bom dia" e o turno começa; às
 * 09:34:10 e 09:34:17 chegam dois áudios; às 09:34:19 o agente responde "recebi o
 * seu áudio, mas não consegui ouvir o conteúdo" — e segundos depois a transcrição
 * dos dois estava pronta, com a reclamação inteira.
 *
 * É a mídia que chega depois de o drain enfileirar o job do texto: na janela de
 * debounce, ou com o job parado na fila atrás de outro turno do mesmo contato. O
 * prompt recebia `[audio]` (`corpoDaMensagem`, `edge/crm/get-lead-context.ts`)
 * porque ninguém reconsultava a conversa entre o despacho e a montagem do
 * contexto. É essa reconsulta que mora aqui — dentro de um teto DECLARADO.
 *
 * ─── Quem chama ──────────────────────────────────────────────────────────────
 *
 * UMA chamada: o handler de `inbound_turn` (`createInboundTurnHandler`, em
 * `inbound-turn.ts`), ANTES de rotear e ANTES de anotar o que o turno viu. O
 * roteador lê a inbound mais nova, e áudio sem transcrição não é sinal nenhum
 * para ele; a anotação já deixa de fora a mídia pendente, então anotar depois da
 * espera promete o que a abertura do turno vai ler (a que vira texto entre a
 * anotação e essa leitura a faz reanotar e reler: `reanotarSeOCorteMudou`; a
 * releitura do modelo não reanota). Follow-up e caso não esperam.
 *
 * ─── O teto, e o que acontece quando ele estoura ─────────────────────────────
 *
 * Duas condições encerram a espera, e as duas terminam em desfecho NOMEADO (o
 * valor devolvido e a linha de log, nunca em silêncio):
 *
 *  - `TETO_ESPERA_DERIVACAO_MS` desde a CHEGADA da mídia: mídia travada há
 *    minutos (retry de falha transitória) não é deste turno — segurá-la seria
 *    fazer o cliente esperar por um problema que não é da mensagem dele.
 *  - o PRAZO (`prazoMs`, absoluto): quem chama calcula uma vez, e a espera nunca
 *    passa dele.
 *
 * Estourar o teto NÃO é falha do turno: ele segue sem o texto. A mídia que chegou
 * durante a espera e não derivou a tempo fica fora da anotação; se a resposta
 * escrita sem ela ficar obsoleta, o envio é descartado
 * (`AgentTurnInput.esperaDaMidiaNoTeto`) e quem responde por ela é o turno dela.
 * O que não pode acontecer é a resposta sair antes de a derivação que estava A
 * CAMINHO terminar: é exatamente a frase "não consegui ouvir" com a transcrição
 * pronta dois segundos depois.
 */
import type pg from 'pg';

import { TETO_ESPERA_DERIVACAO_MS } from '@/lib/messaging/media/derivable';

import { midiaDerivavelPendente } from '../edge/crm/midia-derivavel';
import type { Logger } from '../obs/logger';

/**
 * De quanto em quanto o turno reconsulta. Mais curto que o recuo do drain ao
 * adiar o despacho (4s, `edge/crm/drain.ts`) porque aqui quem paga é a PRIMEIRA
 * resposta ao cliente: 1,5s é o bastante para não somar atraso visível e não
 * transformar a espera num laço de consultas.
 */
export const INTERVALO_DA_ESPERA_MS = 1_500;

/** Como a espera terminou — nomeado, para o log e para quem chamou. */
export type DesfechoDaEsperaDaMidia =
  /** Nada derivável pendente: caminho comum, nenhuma espera. */
  | 'sem_midia_pendente'
  /** Esperou e a mídia virou texto antes do teto. */
  | 'derivacao_concluida'
  /** Estourou o teto: o turno segue SEM o texto, e o log diz que foi isso. */
  | 'teto_da_espera';

export interface ResultadoDaEsperaDaMidia {
  desfecho: DesfechoDaEsperaDaMidia;
  /** Tipo da mídia que segurou a espera (`audio`, `image`, …) — `null` sem mídia. */
  tipo: string | null;
  esperou_ms: number;
  /** Quantas vezes a conversa foi reconsultada. */
  recheques: number;
}

export interface EsperaDaMidiaInput {
  organizationId: string;
  conversationId: string;
  /**
   * Prazo ABSOLUTO (epoch ms) — a espera nunca passa dele. Quem chama calcula
   * uma vez (o handler de `inbound_turn`: agora + teto).
   */
  prazoMs: number;
  log: Logger;
  /** Intervalo entre reconsultas (default `INTERVALO_DA_ESPERA_MS`). */
  intervaloMs?: number;
  /** Relógio injetável — testes que medem o teto sem esperar o relógio. */
  agoraMs?: () => number;
  /** `deps.sleep` do turno: o teste de turno inteiro não paga a espera real. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Espera (dentro do prazo) a mídia derivável da conversa terminar de virar
 * texto. Nunca lança por causa da espera: falha da consulta é do turno, que a
 * trata como qualquer outra leitura — devolver `null` aqui esconderia um defeito
 * de banco atrás de uma resposta sem contexto.
 */
export async function esperarMidiaDerivavel(
  pool: pg.Pool,
  input: EsperaDaMidiaInput,
): Promise<ResultadoDaEsperaDaMidia> {
  const agora = input.agoraMs ?? Date.now;
  const dormir =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalo = input.intervaloMs ?? INTERVALO_DA_ESPERA_MS;
  const inicio = agora();
  const prazo = Math.min(input.prazoMs, inicio + TETO_ESPERA_DERIVACAO_MS);
  // Rede de segurança contra relógio parado/para trás (teste com clock fixo):
  // a espera é limitada por TEMPO **e** por número de reconsultas.
  const limiteDeRecheques = Math.ceil(TETO_ESPERA_DERIVACAO_MS / intervalo) + 1;

  let tipo: string | null = null;
  let recheques = 0;

  for (;;) {
    const pendente = await midiaDerivavelPendente(pool, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
    });
    if (pendente === null) {
      if (tipo !== null) {
        input.log.info('turno: mídia derivável terminou durante a espera — prompt montado com o texto', {
          tipo,
          esperou_ms: agora() - inicio,
          recheques,
        });
      }
      return {
        desfecho: tipo === null ? 'sem_midia_pendente' : 'derivacao_concluida',
        tipo,
        esperou_ms: agora() - inicio,
        recheques,
      };
    }
    tipo = pendente.type;
    const idadeMs = agora() - new Date(pendente.quando).getTime();

    // Mídia que já passou do teto NA CHEGADA: a derivação dela está travada, e
    // não é este turno que a destrava.
    if (idadeMs >= TETO_ESPERA_DERIVACAO_MS) {
      input.log.warn('turno: mídia derivável além do teto da espera já na chegada — seguindo sem o texto', {
        tipo,
        idade_ms: idadeMs,
        teto_ms: TETO_ESPERA_DERIVACAO_MS,
        desfecho: 'teto_da_espera',
      });
      return { desfecho: 'teto_da_espera', tipo, esperou_ms: agora() - inicio, recheques };
    }

    const restante = prazo - agora();
    if (restante <= 0 || recheques >= limiteDeRecheques) {
      input.log.warn('turno: mídia derivável não derivou dentro do teto da espera — seguindo sem o texto', {
        tipo,
        idade_ms: idadeMs,
        esperou_ms: agora() - inicio,
        recheques,
        desfecho: 'teto_da_espera',
      });
      return { desfecho: 'teto_da_espera', tipo, esperou_ms: agora() - inicio, recheques };
    }

    recheques += 1;
    input.log.info('turno: mídia derivável em processamento — esperando antes de montar o prompt', {
      tipo,
      idade_ms: idadeMs,
      recheques,
      restante_ms: restante,
    });
    // ponytail: sem sinal para acordar o laço do event_log (#3693 não portado): a
    // derivação paga até um tick ocioso (EVENT_LOG_DRAIN_IDLE_INTERVAL_MS, padrão
    // 10 s); portar o sinal se a medição da derivação chegar perto do teto.
    await dormir(Math.min(intervalo, restante));
  }
}
