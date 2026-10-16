/**
 * Ler o estado de elegibilidade de uma conversa via pool `pg` (o transporte do
 * agent-engine). Uma query, três tabelas: o modo do gate do canal, as travas do
 * contato, o silêncio da conversa.
 *
 * O drain (decide ENFILEIRAR) e o turno (decide RODAR) chamam isto e passam o
 * resultado para `decidirElegibilidade` — a MESMA regra pura. O sink de envio
 * (`sendTurnMessage`) chama de novo a cada bolha: é leitura por chave primária.
 */
import type pg from "pg";

import { silencioDoBotEhRoteamento } from "@/lib/channels/capabilities";

import {
  decidirElegibilidade,
  montarEstadoDeElegibilidade,
  ttlDaAutorizacaoMs,
  type DecisaoDeElegibilidade,
} from "./gate";

interface LinhaDeElegibilidade {
  contato_oculto: boolean | null;
  channel_metadata: Record<string, unknown> | null;
  force_human: boolean | null;
  assignee_kind: string | null;
  bot_silenced_until: Date | string | null;
  ai_authorized_at: Date | string | null;
  phone_number: string | null;
  provider: string | null;
}

/**
 * Roda a query e a regra. `null` = conversa não encontrada (deixe o chamador
 * decidir; o drain trata como "sem gate", segue o fluxo antigo).
 */
export async function decidirElegibilidadeDaConversa(
  // Só `query`: o sink de envio (`sendTurnMessage`) chama com o que tiver na mão.
  pool: {
    query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
  },
  input: {
    organizationId: string;
    conversationId: string;
    agora: Date;
    ttlMs: number;
    /** Pedido por um follow-up: o silêncio de roteamento (canal sem IA) não conta. */
    followup?: boolean;
  },
): Promise<DecisaoDeElegibilidade | null> {
  const { rows } = await pool.query<LinhaDeElegibilidade>(
    `select
       (ct.inbox_hidden_at is not null) as contato_oculto,
       cs.metadata                  as channel_metadata,
       ct.force_human               as force_human,
       cv.assignee_kind             as assignee_kind,
       cv.bot_silenced_until        as bot_silenced_until,
       ct.ai_authorized_at          as ai_authorized_at,
       ct.phone_number              as phone_number,
       cs.provider                  as provider
     from conversations cv
     join contacts ct
       on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
     join channel_sessions cs
       on cs.id = cv.channel_session_id and cs.organization_id = cv.organization_id
     where cv.organization_id = $1 and cv.id = $2`,
    [input.organizationId, input.conversationId],
  );
  const r = rows[0];
  if (r === undefined) return null;

  return decidirElegibilidade(
    montarEstadoDeElegibilidade({
      contatoOculto: r.contato_oculto,
      aiGate: r.channel_metadata?.ai_gate,
      aiGateMode: r.channel_metadata?.ai_gate_mode,
      aiTestPhoneNumbers: r.channel_metadata?.ai_test_phone_numbers,
      contactPhoneNumber: r.phone_number,
      forceHuman: r.force_human,
      assigneeKind: r.assignee_kind,
      botSilencedUntil: r.bot_silenced_until,
      aiAuthorizedAt: r.ai_authorized_at,
      agora: input.agora,
      ttlMs: input.ttlMs,
      silencioEhRoteamento: input.followup === true && silencioDoBotEhRoteamento(r.provider),
    }),
  );
}

/**
 * Jobs cujo efeito é ORDEM de uma pessoa (resposta aprovada, link da reunião):
 * a conversa ter dono humano é o estado normal deles, não motivo para calar.
 */
const A_MANDO_DE_PESSOA = new Set(["approved_reply", "transactional_delivery"]);

/**
 * Uma pessoa está no comando desta conversa AGORA? Devolve o motivo, ou `null`.
 *
 * Só os três vetos de pessoa contam (`force_human`, silêncio em vigor, dono
 * humano): são os `!permite` sem `bloqueioPorAllowlist`. A mesma leitura serve
 * ao envio, bolha a bolha (`sendTurnMessage`, onde está a história do defeito),
 * e às ferramentas de escrita do turno (`guardServiceTools`).
 */
export async function pessoaNoComandoDaConversa(
  pool: Parameters<typeof decidirElegibilidadeDaConversa>[0],
  alvo: { organizationId: string; conversationId: string },
  kind: string | undefined,
): Promise<string | null> {
  if (kind !== undefined && A_MANDO_DE_PESSOA.has(kind)) return null;
  const elegib = await decidirElegibilidadeDaConversa(pool, {
    ...alvo,
    agora: new Date(),
    ttlMs: ttlDaAutorizacaoMs(process.env),
    // Mesma exceção do começo do turno: silêncio de canal sem IA é roteamento.
    followup: kind === "followup_turn",
  });
  return elegib !== null && !elegib.permite && !elegib.bloqueioPorAllowlist ? elegib.motivo : null;
}
