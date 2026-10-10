/**
 * O AVISO NA CENTRAL QUANDO O DRAIN DA IA PARA.
 * Porte do upstream melgarafael/DeskcommCRM#2691 (issue #2505 de lá).
 *
 * O caso real do upstream: o drain do `ai_agent.dispatch_requested` ficou DOIS
 * DIAS esperando uma consulta que nunca voltou, com o `/healthz` dizendo `ok`
 * e os eventos se acumulando com `attempts=0`. A CAUSA daquela vez este fork já
 * fechou (`query_timeout` e keepAlive em `lib/agent-engine/db/pool.ts`); este
 * arquivo fecha a VISIBILIDADE, para qualquer outra causa de travamento.
 *
 * Pane GLOBAL chega por uma linha por organização (a Central é tenant-aware),
 * com dedupe por título estável, resolução sozinha quando o estado volta, e
 * QUALQUER falha vira `warn`: o aviso é acessório e não pode derrubar o worker.
 * Quem fala com o banco é o POOL CRU do worker, numa instrução única
 * (`insert … select … where not exists`) em vez de ler-depois-escrever.
 *
 * O título é ESTÁVEL: é ele que deduplica entre reinícios do worker e é ele
 * que a resolução usa para fechar o episódio. Mudar o texto sem mudar quem o
 * procura deixaria avisos órfãos abertos para sempre.
 */
import type pg from "pg";

import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Título estável do episódio: dedupe e resolução dependem deste literal. */
export const TITULO_DRAIN_PARADO = "As respostas automáticas da IA estão paradas";

const CORPO_DRAIN_PARADO =
  "O processamento que transforma as mensagens recebidas em respostas da IA parou de avançar. " +
  "As mensagens continuam chegando e ficando registradas, mas a IA não responde até o processamento voltar. " +
  "Quem administra a instalação deve revisar o serviço do worker (log e /healthz) e reiniciá-lo se ele não voltar sozinho.";

export type EstadoDoDrain = "parado" | "saudavel";

/**
 * Sincroniza o aviso: abre o que falta quando parado, resolve tudo quando
 * saudável. Nunca lança: falha aqui vira `warn` e o incidente continua tendo
 * o 503 do `/healthz` como sinal.
 */
export async function sincronizarAvisoDoDrain(
  pool: pg.Pool,
  estado: EstadoDoDrain,
  log: Logger,
): Promise<void> {
  try {
    if (estado === "saudavel") {
      await pool.query(
        `update agent_inbox_items
            set status = 'resolved', resolved_at = now()
          where kind = 'other' and title = $1 and status = 'open'`,
        [TITULO_DRAIN_PARADO],
      );
      return;
    }
    // Uma linha por organização que ainda não tem o aviso ABERTO. Uma instrução
    // só: o `not exists` por organização é o que impede a tempestade de avisos
    // num incidente que dura dias, e o reaper chama isto a cada tique.
    await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body)
       select o.id, 'other', 'warn', $1, $2
         from organizations o
        where not exists (
          select 1 from agent_inbox_items i
           where i.organization_id = o.id and i.kind = 'other' and i.title = $1 and i.status = 'open'
        )`,
      [TITULO_DRAIN_PARADO, CORPO_DRAIN_PARADO],
    );
  } catch (err) {
    log.warn("drain: falhei ao sincronizar o aviso de laço parado na Central", {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}
