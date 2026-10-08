/**
 * MCP read tools sobre /api/v1/conversations e /api/v1/messages (Spec 11 §3.1).
 *
 * - `crm_list_conversations` -> listConversationsHandler
 * - `crm_get_conversation`   -> getConversationHandler
 * - `crm_get_conversation_history` -> listMessagesHandler (carrega historico)
 */
import { z } from "zod";

import {
  listConversationsHandler,
  getConversationHandler,
} from "@/app/api/v1/conversations/_handler";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { getQueuePositions } from "@/lib/routing/queue";
import { resolveUserNames } from "./_users";
import type { McpContext, McpToolDefinition } from "../types";
import { foraDaConversa } from "../fora-da-conversa";

/**
 * Conversa está na fila = sem dono ∧ status de espera.
 *
 * A lista de status vem da constante compartilhada, e não de um literal: era
 * `=== "open"` aqui, `in ('open','pending')` no trigger de roteamento, e as duas
 * coisas ao mesmo tempo dentro de `lib/routing/queue.ts`. O que a IA lia pela
 * tool e o que a pessoa via na tela não eram a mesma fila.
 */
function isInQueue(c: { comando_da_conversa?: string | null }): boolean {
  // Ele decide UMA coisa: vale a pena buscar as posições de fila para esta
  // página? Por isso é liberal de propósito — pergunta "não tem dono e não
  // acabou", que cobre tanto a org COM automático (só `aguardando` está na fila)
  // quanto a SEM (`automatico` também está, ver `comandosDaFila`). Errar para o
  // lado do sim custa uma consulta; errar para o não some com a posição que a IA
  // devolve ao cliente.
  const q = c.comando_da_conversa;
  return q === "aguardando" || q === "automatico";
}

const FORA = Symbol("fora_da_conversa");

/**
 * A conversa pedida, conferida contra o contato do turno.
 *
 * Sem `ctx.contatoDoTurno`, é o `getConversationHandler` de sempre (o `404`
 * sobe). Com ele, conversa de outro paciente, inexistente ou de outra
 * organização viram o MESMO `FORA`; erro que não é `404` sobe sempre — infra
 * não é limite de negócio.
 */
async function conversaDoTurno(ctx: McpContext, conversationId: string) {
  const handlerCtx = {
    organization_id: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
  };
  if (!ctx.contatoDoTurno) return getConversationHandler(ctx.supabase, handlerCtx, conversationId);
  try {
    const conv = await getConversationHandler(ctx.supabase, handlerCtx, conversationId);
    return conv.contact_id === ctx.contatoDoTurno ? conv : FORA;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return FORA;
    throw e;
  }
}

const listInputShape = {
  contact_id: z.string().uuid().optional(),
  // `pending` entra: é o estado da conversa que o próprio agente escalou, e sem
  // ele a IA não conseguia listar o que ela mesma passou para uma pessoa.
  status: z
    .enum(["open", "pending", "claimed", "ai_handling", "closed", "archived"])
    .optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
};

export const crmListConversations: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_conversations",
  description:
    "Lista conversas do CRM com filtros opcionais por contato e status. Retorna preview da ultima mensagem. " +
    "Campos de governança por conversa: assignee_kind ('user'|'ai'|null), assigned_to_user_id + assigned_to_user_name (só o nome do atendente, sem email/telefone), tags[], e queue_position (posição 1-based na fila do inbox — só quando na fila, senão null). " +
    "Em conversa de atendimento, devolve apenas as conversas do contato desta conversa.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── QUEM ESTÁ NA OUTRA PONTA ────────────────────────────────────────────
    //
    // A listagem filtra `organization_id`, mas alcançava os outros pacientes
    // da MESMA clínica — com `last_message_preview` junto, texto do lado de lá
    // indo para o WhatsApp de quem está do lado de cá. Com `ctx.contatoDoTurno`
    // (contexto de confiança do runtime), o contato vai NO `WHERE` do handler,
    // antes do `.limit`: a página é dele, e cursor/`has_more` seguem honestos.
    // Pedir explicitamente OUTRO paciente é interseção vazia. Sem contato do
    // turno, `contatoEfetivo` é o `contact_id` pedido, ou nada.
    const doTurno = ctx.contatoDoTurno;
    if (doTurno && input.contact_id && input.contact_id !== doTurno) {
      return { conversations: [], cursor: null, has_more: false };
    }
    const contatoEfetivo = doTurno ?? input.contact_id;
    const result = await listConversationsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        // O handler espera LISTA desde que o filtro passou a aceitar vários.
        status: input.status ? [input.status] : undefined,
        // `undefined` EXPLÍCITO: `.optional()` no Zod produz uma chave
        // OBRIGATÓRIA de tipo `X | undefined`, não uma chave opcional — omiti-la
        // é erro de tipo. A tool do MCP não expõe filtro por comando (quem
        // pergunta é a tela), então ela não filtra por ele.
        comando: undefined,
        // `tag` e `modo` também saem `undefined` EXPLICITO, e pela MESMA razão do
        // `comando`: o `.transform()` do schema de marcador (#1274) torna a chave
        // de SAÍDA obrigatória-de-tipo (`string[] | undefined`), não opcional.
        // A tool do MCP não expõe filtro por etiqueta (quem pergunta é a tela), e
        // omitir a chave seria erro de tipo — não omissão silenciosa.
        tag: undefined,
        modo: undefined,
        // O contato vai NA CONSULTA, não num recorte da página já truncada:
        // filtrar depois escondia a conversa mais antiga do mesmo paciente e
        // deixava o cursor descrevendo a varredura da organização.
        contact_id: contatoEfetivo,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    const conversations = result.conversations;
    // Nomes (dedupe) e posições de fila (1 query cada) — sem N+1 na listagem.
    const names = await resolveUserNames(
      ctx.supabase,
      conversations.map((c) => c.assigned_to_user_id),
    );
    const queueMap = conversations.some(isInQueue)
      ? await getQueuePositions(ctx.supabase, ctx.organizationId)
      : new Map<string, number>();
    return {
      conversations: conversations.map((c) => ({
        id: c.id,
        contact_id: c.contact_id,
        channel: c.channel,
        status: c.status,
        assigned_to_user_id: c.assigned_to_user_id,
        assignee_kind: c.assignee_kind,
        assigned_to_user_name: c.assigned_to_user_id
          ? (names.get(c.assigned_to_user_id) ?? null)
          : null,
        tags: c.tags ?? [],
        queue_position: queueMap.get(c.id) ?? null,
        last_message_preview: c.last_message_preview,
        last_message_at: c.last_message_at,
        unread_count: c.unread_count_for_assignee,
        is_group: c.is_group,
      })),
      cursor: result.cursor,
      has_more: result.has_more,
    };
  },
};

const getInputShape = {
  conversation_id: z.string().uuid(),
};

export const crmGetConversation: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_conversation",
  description:
    "Retorna detalhes de uma conversa pelo UUID. Inclui status, atribuicao, contato, ultima atividade. " +
    "Governança: assignee_kind ('user'|'ai'|null), assigned_to_user_id + assigned_to_user_name (só o nome, sem email/telefone), tags[], e queue_position (1-based na fila do inbox — null quando não está na fila). " +
    "Em conversa de atendimento, devolve apenas conversas do contato desta conversa.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── A CONVERSA DE QUEM NÃO É DESTA CONVERSA NÃO ABRE AQUI ───────────────
    //
    // RECUSA, e não tradução. A ida ao handler acontece porque é ela que diz
    // de quem é a conversa; o que não sai daqui é a RESPOSTA. Com turno, o
    // `404` (não existe, ou é de outra organização) vira a MESMA recusa da
    // conversa de outro paciente — um uuid não ganha veredito sobre
    // existência. Sem turno, tudo como antes.
    const conv = await conversaDoTurno(ctx, input.conversation_id);
    if (conv === FORA) {
      return foraDaConversa("a conversa de quem não é o paciente desta conversa não é sua para ler");
    }
    const names = await resolveUserNames(ctx.supabase, [conv.assigned_to_user_id]);
    const queue_position = isInQueue(conv)
      ? ((await getQueuePositions(ctx.supabase, ctx.organizationId)).get(conv.id) ?? null)
      : null;
    return {
      id: conv.id,
      contact_id: conv.contact_id,
      channel_session_id: conv.channel_session_id,
      channel: conv.channel,
      status: conv.status,
      assigned_to_user_id: conv.assigned_to_user_id,
      assignee_kind: conv.assignee_kind,
      assigned_to_user_name: conv.assigned_to_user_id
        ? (names.get(conv.assigned_to_user_id) ?? null)
        : null,
      tags: conv.tags ?? [],
      queue_position,
      assigned_at: conv.assigned_at,
      last_inbound_at: conv.last_inbound_at,
      last_outbound_at: conv.last_outbound_at,
      last_message_at: conv.last_message_at,
      last_message_preview: conv.last_message_preview,
      is_group: conv.is_group,
      group_chat_id: conv.group_chat_id,
      created_at: conv.created_at,
    };
  },
};

const historyInputShape = {
  conversation_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};

export const crmGetConversationHistory: McpToolDefinition<typeof historyInputShape> = {
  name: "crm_get_conversation_history",
  description:
    "Carrega historico de mensagens de uma conversa. Use para dar contexto ao agente sem inflar o system prompt." +
    " Em conversa de atendimento, devolve apenas o histórico da conversa do contato desta conversa.",
  inputSchema: historyInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // A mesma recusa de `crm_get_conversation`, e ANTES de ler as mensagens:
    // o histórico é a leitura que mais sai do prédio, e carregar a página de
    // outro paciente só para jogá-la fora seria deixar o dado dele entrar na
    // memória do turno. Sem contato do turno, o caminho é idêntico ao de antes.
    if (ctx.contatoDoTurno && (await conversaDoTurno(ctx, input.conversation_id)) === FORA) {
      return foraDaConversa("o histórico de quem não é o paciente desta conversa não é seu para ler");
    }
    const result = await listMessagesHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.conversation_id,
      { limit: input.limit, cursor: input.cursor },
    );
    return {
      messages: result.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.body,
        media_url: m.media_url,
        sent_via: m.sent_via,
        sent_at: m.sent_at,
        status: m.status,
      })),
      cursor: result.cursor,
      has_more: result.has_more,
    };
  },
};
