/**
 * O TRECHO RECENTE DA CONVERSA, EM TEXTO, PARA O CLASSIFICADOR DO ROTEADOR.
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * O classificador recebia só a última mensagem. "Quarta", "pode ser" e "sim"
 * não têm assunto próprio: o assunto está na pergunta que veio antes. Sem ela,
 * o classificador chutava uma intenção com confiança alta e a conversa trocava
 * de agente no meio de um agendamento.
 *
 * ─── Só o atendimento ATUAL ─────────────────────────────────────────────────
 *
 * A fronteira é a mesma do histórico que o agente lê: conversa fechada e
 * reaberta começa do zero. Mensagem de um atendimento encerrado puxaria o
 * classificador para um assunto que já acabou.
 *
 * ─── O que entra no texto, e o que nunca entra ──────────────────────────────
 *
 * O corpo como o prompt do agente o lê (`corpoDaMensagem`): texto digitado,
 * transcrição já pronta ou o marcador `[tipo]`. Nunca a mídia, nunca o anexo.
 * Cada mensagem numa linha só e cortada: isto vai a um modelo barato e a
 * resposta dele é uma palavra.
 *
 * Só lê quem liga o modo novo do roteador (`permanencia: 'agente'`): é a
 * primeira vez que texto de mensagens anteriores vai ao provedor do
 * classificador, e roteador existente não muda de prompt sem pedir.
 */
import type { Queryable } from "../queue/queue";
import { corpoDaMensagem, type CorpoDaMensagemRow } from "../edge/crm/get-lead-context";

export const MAXIMO_DE_MENSAGENS_NO_HISTORICO = 6;

/** Uma mensagem cabe numa linha e não passa disto. */
const MAXIMO_POR_MENSAGEM = 300;

export interface MensagemRecente {
  direction: "inbound" | "outbound";
  texto: string;
}

/**
 * As últimas mensagens do atendimento ATUAL, da mais antiga para a mais nova,
 * SEM a inbound mais recente (ela é o sinal que o classificador já recebe).
 */
export async function historicoRecente(
  db: Queryable,
  organizationId: string,
  conversationId: string,
): Promise<MensagemRecente[]> {
  // ⚠️ O `exists(...)` é a fronteira de atendimento de
  // lib/agent-engine/edge/crm/get-lead-context.ts (consulta do `history`),
  // copiada. As duas consultas têm de andar juntas: se uma mudar e a outra não,
  // o classificador passa a ver uma conversa diferente da que o agente vê.
  const { rows } = await db.query<CorpoDaMensagemRow & { direction: "inbound" | "outbound" }>(
    `select direction, type, body, media_url, media_storage_path, media_derived_text
       from messages
      where organization_id = $1 and conversation_id = $2
        and direction in ('inbound', 'outbound')
        and exists(select 1 from conversations c where c.organization_id=$1 and c.id=$2
          and ((messages.direction='inbound' and messages.service_revision=c.service_revision
            and messages.demanda_id is not distinct from c.current_demanda_id)
            or (messages.direction='outbound' and messages.sent_at >= c.service_started_at)))
      order by sent_at desc, id desc
      limit $3`,
    // Uma a mais: a mais nova costuma ser o próprio sinal, e sai.
    [organizationId, conversationId, MAXIMO_DE_MENSAGENS_NO_HISTORICO + 1],
  );
  const semOSinal = rows[0]?.direction === "inbound" ? rows.slice(1) : rows;
  return semOSinal
    .slice(0, MAXIMO_DE_MENSAGENS_NO_HISTORICO)
    .reverse()
    .map((m) => ({
      direction: m.direction,
      // Quebra de linha abriria uma "linha nova" dentro do prompt do classificador.
      texto: corpoDaMensagem(m).replace(/\s+/g, " ").trim().slice(0, MAXIMO_POR_MENSAGEM),
    }))
    .filter((m) => m.texto !== "");
}

/** O bloco em texto. Vazio quando não há o que mostrar: o prompt fica o de sempre. */
export function renderHistoricoRecente(msgs: readonly MensagemRecente[]): string {
  if (msgs.length === 0) return "";
  return [
    "Conversa recente deste atendimento (da mais antiga para a mais nova):",
    ...msgs.map((m) => `${m.direction === "inbound" ? "Lead" : "Atendimento"}: ${m.texto}`),
  ].join("\n");
}
