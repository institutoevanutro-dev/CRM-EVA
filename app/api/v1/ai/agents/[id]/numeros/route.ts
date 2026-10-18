import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/ai/agents/:id/numeros — em quais números o agente atende (manager+)
 * PUT /api/v1/ai/agents/:id/numeros — muda a declaração (admin)
 *
 * Corpo do PUT: `{ "todos": true }` (o padrão: atende em todos os números) ou
 * `{ "channel_session_ids": ["<uuid>", ...] }` (só nesses). A lista mora em
 * `ai_agent_channel_sessions` (migration 0380): nenhuma linha = todos.
 *
 * organization_id vem da sessão (requireRole), nunca do corpo. O admin client
 * filtra a organização em toda leitura e escrita. Mudança bem-sucedida grava
 * `ai_agent.numbers_changed` com o antes e o depois.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2854 de @webtecnica).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const declaracaoDeNumerosSchema = z.union([
  z.object({ todos: z.literal(true) }).strict(),
  z.object({ channel_session_ids: z.array(z.string().uuid()).min(1).max(50) }).strict(),
]);

type Admin = ReturnType<typeof createAdminClient>;

/** `null` = todos os números. */
async function numerosDeclarados(admin: Admin, orgId: string, agentId: string): Promise<string[] | null> {
  const { data, error } = await admin
    .from("ai_agent_channel_sessions")
    .select("channel_session_id")
    .eq("organization_id", orgId)
    .eq("agent_id", agentId);
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as Array<{ channel_session_id: string }>).map((r) => r.channel_session_id).sort();
  return ids.length === 0 ? null : ids;
}

async function agenteDaOrg(admin: Admin, orgId: string, agentId: string): Promise<boolean> {
  const { data } = await admin
    .from("ai_agents")
    .select("id")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .maybeSingle();
  return data != null;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  if (!(await agenteDaOrg(admin, orgId, id))) {
    return fail("not_found", t("Agent não encontrado."), 404, { requestId });
  }
  try {
    const ids = await numerosDeclarados(admin, orgId, id);
    return ok({ todos: ids === null, channel_session_ids: ids ?? [] }, { requestId });
  } catch {
    return fail("internal_error", "Erro ao ler os números do agente.", 500, { requestId });
  }
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const orgId = org.orgId;

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = declaracaoDeNumerosSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const novos = "todos" in parsed.data ? null : [...new Set(parsed.data.channel_session_ids)].sort();

  const admin = createAdminClient();
  if (!(await agenteDaOrg(admin, orgId, id))) {
    return fail("not_found", t("Agent não encontrado."), 404, { requestId });
  }

  if (novos !== null) {
    // Número de outra organização ou arquivado não entra: a FK composta já
    // recusaria o primeiro, mas a resposta tem de dizer qual e por quê.
    const { data: validos, error } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .in("id", novos);
    if (error) return fail("internal_error", "Erro ao conferir os números.", 500, { requestId });
    const achados = new Set(((validos ?? []) as Array<{ id: string }>).map((r) => r.id));
    const ausentes = novos.filter((n) => !achados.has(n));
    if (ausentes.length > 0) {
      return fail(
        "validation_failed",
        t("O número de WhatsApp escolhido não existe nesta organização. Recarregue a página e escolha de novo."),
        422,
        { requestId, details: { channel_session_ids: ausentes } },
      );
    }
  }

  let antes: string[] | null;
  try {
    antes = await numerosDeclarados(admin, orgId, id);
  } catch {
    return fail("internal_error", "Erro ao ler os números do agente.", 500, { requestId });
  }

  // ORDEM: primeiro acrescenta, depois tira. Ao contrário, entre os dois passos
  // a lista poderia ficar VAZIA — e vazia quer dizer "todos os números": o
  // agente falaria por um instante onde a declaração diz que ele não fala.
  if (novos !== null) {
    const { error } = await admin.from("ai_agent_channel_sessions").upsert(
      novos.map((channel_session_id) => ({
        organization_id: orgId,
        agent_id: id,
        channel_session_id,
        created_by: user.id,
      })),
      { onConflict: "agent_id,channel_session_id", ignoreDuplicates: true },
    );
    if (error) return fail("internal_error", "Erro ao gravar os números do agente.", 500, { requestId });
  }
  let remover = admin.from("ai_agent_channel_sessions").delete().eq("organization_id", orgId).eq("agent_id", id);
  if (novos !== null) remover = remover.not("channel_session_id", "in", `(${novos.join(",")})`);
  const { error: delErr } = await remover;
  if (delErr) return fail("internal_error", "Erro ao gravar os números do agente.", 500, { requestId });

  const mudou = JSON.stringify(antes) !== JSON.stringify(novos);
  if (mudou) {
    void audit({
      action: "ai_agent.numbers_changed",
      actorUserId: user.id,
      organizationId: orgId,
      resourceType: "ai_agent",
      resourceId: id,
      requestId,
      metadata: { antes: antes ?? "todos", depois: novos ?? "todos" },
    });
  }

  return ok({ todos: novos === null, channel_session_ids: novos ?? [] }, { requestId });
}
