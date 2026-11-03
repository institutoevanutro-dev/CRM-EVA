/**
 * Qual mídia da conversa ainda está virando TEXTO — a pergunta que decide se uma
 * resposta pode sair já.
 *
 * TRÊS peças fazem esta pergunta e não podem discordar:
 *
 *  - o despacho do turno (`./drain.ts`), antes de enfileirar o job;
 *  - o handler de `inbound_turn` (`agent/espera-da-midia.ts`), antes de rotear e
 *    de montar o prompt — é a mídia que chega depois de o drain enfileirar o job
 *    do texto (#3836 do original);
 *  - a anotação do turno (`agent/turno-ja-respondido.ts`), que repete a régua em
 *    SQL, dentro do próprio UPDATE, para prometer só o que o turno pôde ler.
 *
 * Duas cópias da consulta divergiriam no primeiro ajuste, e o sintoma seria o
 * pior possível: uma ponta esperando por uma régua e a outra liberando a
 * resposta pela outra. Por isso a leitura mora aqui, e as duas primeiras
 * importam; a anotação usa as mesmas constantes e o mesmo `sqlMidiaVaiSerLida`.
 *
 * ─── A régua ─────────────────────────────────────────────────────────────────
 *
 * `direction = 'inbound'`, tipo em `TIPOS_DERIVAVEIS`, e status FORA de
 * `DERIVACAO_TERMINADA` (`ready`/`failed`/`skipped` — `skipped` é a mídia que o
 * worker desiste de ler DE PROPÓSITO, e sem ele a linha ficaria null para sempre
 * segurando a resposta do texto seguinte até o teto).
 *
 * `media_url is not null` é a PRÉ-CONDIÇÃO de toda a esteira: sem ela a
 * derivação nunca é pedida e o status fica null para sempre — esperar por ela só
 * atrasaria a resposta.
 *
 * E só a mídia que VAI ser lida (`sqlMidiaVaiSerLida`): o vídeo com a leitura
 * desligada e a mídia importada do histórico só ganham estado final depois de
 * baixadas, e segurar o texto por elas atrasava a resposta até o teto.
 *
 * A âncora de idade é `created_at` — quando a mídia CHEGOU A NÓS —, nunca
 * `sent_at`. No inbound, `sent_at` é o relógio do aparelho: uma foto entregue
 * com atraso (aparelho offline, canal reconectando) nasceria "além do teto" e o
 * turno seguiria sem a leitura que acabou de começar.
 */
import type pg from 'pg';

import {
  DERIVACAO_TERMINADA,
  TIPOS_DERIVAVEIS,
  sqlMidiaVaiSerLida,
} from '@/lib/messaging/media/derivable';

export interface MidiaDerivavelPendente {
  type: string;
  /** `null` = a derivação nem foi pedida ainda; qualquer valor fora de `DERIVACAO_TERMINADA` é pendente. */
  status: string | null;
  /** `messages.created_at` (ISO 8601) — a hora em que a mídia chegou, âncora de toda espera. */
  quando: string;
}

/**
 * O instante de chegada em ms, aceitando as DUAS formas que `pg` devolve para
 * `timestamptz`.
 *
 * Isto não é zelo de tipo: o driver `pg` converte `timestamptz` em `Date` pelo
 * parser do OID 1184, e o repositório NÃO troca esse parser. Exigir
 * `typeof quando === 'string'` fazia esta régua devolver `null` para mídia
 * pendente REAL (medido contra Postgres de verdade no original, #3845): o áudio
 * estava na conversa, sem derivação, e a régua dizia "nada pendente". O dublê de
 * pool dos testes de unidade devolve string e escondia a fronteira.
 *
 * `null` = hora ilegível (ou ausente). Linha sem hora legível nunca sairia do
 * teto (`NaN` não é maior que nada) e seguraria a resposta para sempre — o
 * oposto do que a espera existe para fazer.
 */
function instanteDeChegada(quando: unknown): number | null {
  if (typeof quando === 'string') {
    const ms = new Date(quando).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (quando instanceof Date) {
    const ms = quando.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Uma linha só é PENDENTE se der para esperar por ela: tipo derivável (o `where`
 * já filtra, e a checagem aqui é a mesma régua do lado de cá), status fora de
 * `DERIVACAO_TERMINADA` e uma hora de chegada legível.
 */
function ehPendente(m: { type?: unknown; media_derived_status?: unknown; quando?: unknown }): boolean {
  if (typeof m.type !== 'string' || !TIPOS_DERIVAVEIS.has(m.type)) return false;
  if (DERIVACAO_TERMINADA.has(typeof m.media_derived_status === 'string' ? m.media_derived_status : '')) {
    return false;
  }
  return instanteDeChegada(m.quando) !== null;
}

/**
 * A mídia mais RECENTE da conversa que ainda não terminou de virar texto — é ela
 * que a resposta não pode perder — ou `null` quando não há nada pendente.
 */
export async function midiaDerivavelPendente(
  pool: pg.Pool,
  input: { organizationId: string; conversationId: string },
): Promise<MidiaDerivavelPendente | null> {
  const { rows } = await pool.query<{
    type: string;
    media_derived_status: string | null;
    quando: string | Date;
  }>(
    `select type, media_derived_status, created_at as quando
       from messages m
      where organization_id = $1
        and conversation_id = $2
        and direction = 'inbound'
        and type = any($3::text[])
        and media_url is not null
        and ${sqlMidiaVaiSerLida('m')}
      order by created_at desc
      limit 20`,
    [input.organizationId, input.conversationId, [...TIPOS_DERIVAVEIS]],
  );
  const pendente = rows.find(ehPendente);
  if (pendente === undefined) return null;
  const emMs = instanteDeChegada(pendente.quando);
  if (emMs === null) return null;
  return {
    type: pendente.type,
    status: pendente.media_derived_status ?? null,
    quando: new Date(emMs).toISOString(),
  };
}
