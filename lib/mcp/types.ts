import type { MeetingBookingContext } from "@/lib/agenda/meet-delivery";
/**
 * Tipos compartilhados do MCP server interno (Spec 11).
 *
 * Cada tool MCP é uma `McpToolDefinition` que declara name + description +
 * inputSchema (Zod) + handler. Handlers recebem `McpContext` resolvido pelo
 * server core (org, role, actor, supabase admin client).
 */
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { Role } from "@/lib/auth/types";

export interface McpContext {
  /** Somente o runtime in-process fornece o job original, nunca o cliente MCP. */
  meetingBooking?: MeetingBookingContext;
  /**
   * O CONTATO que este turno atende — contexto de CONFIANÇA do handler.
   *
   * Nasce do lado de quem monta o turno (`job.contact_id`) e NUNCA vem dos
   * argumentos da tool — o modelo não escreve este campo nem tem como
   * alcançá-lo. `lib/ai/runtime/tools.ts` o injeta na chamada do handler, que é
   * o único ponto que tem `input.contatoDoTurno`, para valer para todo chamador
   * de `pickToolsFromMcp` (turno de atendimento, Operador, runtime nativo).
   *
   * Ausente nos ingressos de fora do turno (rota HTTP, MCP externo, token de
   * integração) — e a ausência é o que mantém o comportamento deles intacto.
   * Com ele, as leituras do catálogo só alcançam dados DESTE paciente: a
   * conversa é com alguém, e a ficha, a busca, a conversa, o histórico, os
   * negócios, a agenda e os pedidos de outro paciente não saem do turno.
   */
  contatoDoTurno?: string;
  organizationId: string;
  role: Role;
  actor: Actor;
  apiTokenId: string;
  requestId: string;
  /** Service-role admin client. Tools devem filtrar `organization_id` em toda query. */
  supabase: SupabaseClient;
}

export type McpToolCategory = "read" | "write" | "handoff";

export interface McpToolDefinition<TInput extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TInput;
  category: McpToolCategory;
  /** Role mínima para invocar. Read default agent; Write default manager. */
  requiresRole: Role;
  /**
   * Scope obrigatório no `api_tokens.scopes` (ex: `mcp:read`, `mcp:write`).
   * Ausência → -32002 forbidden.
   */
  requiresScope: "mcp:read" | "mcp:write";
  handler: (
    input: z.infer<z.ZodObject<TInput>>,
    ctx: McpContext,
  ) => Promise<unknown>;
}
