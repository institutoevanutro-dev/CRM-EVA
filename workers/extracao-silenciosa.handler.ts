/**
 * Expõe a extração silenciosa de cadastro (`lib/contacts/extracao-silenciosa.ts`,
 * migration 0407) ao dispatcher do `event_log`.
 *
 * Consumidor PRÓPRIO de `message.received`, ao lado de `ai-response-worker.v1`:
 * o worker de resposta continua pulando a conversa silenciada
 * (`silenced_post_handoff`) exatamente como antes, e esta peça só lê o
 * cadastro — nenhuma mensagem sai daqui. A chave abaixo é a que vai para
 * `event_log.consumed_by[]`.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { extrairCadastroSilencioso } from "@/lib/contacts/extracao-silenciosa";
import { createAdminClient } from "@/lib/supabase/admin";

export const EXTRACAO_SILENCIOSA_HANDLER_KEY = "extracao-silenciosa.v1";

export const extracaoSilenciosaHandler: EventHandler = {
  key: EXTRACAO_SILENCIOSA_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const messageId = (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
    if (!messageId) {
      return { consumer_key: EXTRACAO_SILENCIOSA_HANDLER_KEY, status: "skipped", detail: "sem_message_id" };
    }
    // Erro de banco sobe para o dispatcher, que registra `error` e tenta de
    // novo: a releitura é segura (rastro por mensagem + travas do banco).
    const r = await extrairCadastroSilencioso(createAdminClient(), {
      organizationId: row.organization_id,
      messageId,
    });
    if (r.status === "ignorado") {
      return { consumer_key: EXTRACAO_SILENCIOSA_HANDLER_KEY, status: "skipped", detail: r.motivo };
    }
    return {
      consumer_key: EXTRACAO_SILENCIOSA_HANDLER_KEY,
      status: "ok",
      // Só os NOMES dos campos — `consumed_by`/detalhe é lido por operador.
      detail: `preenchidos=${r.preenchidos.join(",")};propostos=${r.propostos.join(",")}`,
    };
  },
};
