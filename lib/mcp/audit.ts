/**
 * Audit log dedicado para tool calls MCP.
 *
 * Spec 11 §6: cada tool call gera 1 entrada em `api_audit_log` com
 * `action='mcp.tool_called'`, `actor_type='ai_agent'` (quando aplicavel),
 * `actor_api_token_id=<token>`, `resource_type='mcp_tool'`, `resource_id=<tool_name>`.
 *
 * Fire-and-forget: falha de write nunca bloqueia retorno da tool.
 */
import { audit } from "@/lib/audit";
import type { McpContext } from "./types";

interface AuditMcpToolCallInput {
  ctx: McpContext;
  toolName: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  resultSummary?: string;
}

/**
 * ALLOWLIST, não denylist (achado A6 da auditoria de 2026-09-29).
 *
 * A trilha é imutável para os papéis do PostgREST e fica 5 anos. A versão
 * anterior tirava 5 chaves e gravava o resto — texto da mensagem, telefone,
 * nome, nota do paciente —, que sobrevivia ao pedido de exclusão do titular
 * (LGPD, art. 18). Agora só passa o que responde "o quê e em quem": ids (uuid),
 * enums curtos, números e booleanos. Chave nova nasce redigida.
 */
const CHAVES_DE_ENUM = new Set([
  "type", "campo", "urgency", "outcome", "status", "state", "situacao", "target_kind", "currency",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM = /^[a-z0-9_.-]{1,40}$/i;
const REDIGIDO = "[redacted]";

function valorPermitido(chave: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (/(^|_)ids?$/.test(chave)) {
    if (typeof v === "string") return UUID.test(v) ? v : REDIGIDO;
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && UUID.test(x) ? x : REDIGIDO));
    return REDIGIDO;
  }
  if (CHAVES_DE_ENUM.has(chave) && typeof v === "string" && ENUM.test(v)) return v;
  return REDIGIDO;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = valorPermitido(k.toLowerCase(), v);
  return out;
}

/** Só contagem ("3 contacts") ou id — nunca conteúdo do resultado. */
const RESUMO_PERMITIDO = /^(\d+ [a-z_]+|id=[0-9a-f-]{36})$/i;

export async function auditMcpToolCall(input: AuditMcpToolCallInput): Promise<void> {
  const { ctx, toolName, args, durationMs, success, errorMessage, resultSummary } = input;

  const metadata: Record<string, unknown> = {
    actor_type: ctx.actor.type,
    actor_id: ctx.actor.id,
    tool_name: toolName,
    args: redactArgs(args),
    duration_ms: durationMs,
    success,
  };

  if (resultSummary && RESUMO_PERMITIDO.test(resultSummary)) metadata.result_summary = resultSummary;
  if (errorMessage) metadata.error = errorMessage.slice(0, 500);
  if (ctx.actor.type === "ai_agent" && ctx.actor.api_token_id) {
    metadata.actor_api_token_id = ctx.actor.api_token_id;
  }

  await audit({
    action: "mcp.tool_called",
    // Quem age via MCP é um TOKEN, nunca uma linha de auth.users: para um token
    // comum, ctx.actor.id é o id do próprio token (lib/mcp/auth.ts), e mandá-lo
    // como actorUserId estourava a FK api_audit_log_actor_user_id_fkey. O ator
    // já fica registrado em actorApiTokenId e em metadata.actor_id.
    actorUserId: null,
    actorApiTokenId: ctx.apiTokenId,
    organizationId: ctx.organizationId,
    resourceType: "mcp_tool",
    // `resource_id` é uuid no banco; o nome da tool ia aqui como texto e o
    // insert morria com "invalid input syntax for type uuid: crm_create_lead".
    // O nome já viaja em metadata.tool_name, que é jsonb.
    resourceId: null,
    requestId: ctx.requestId,
    metadata,
  });
}
