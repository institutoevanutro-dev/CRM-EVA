/**
 * GET/POST /api/v1/cron/handoff-devolucao — devolve ao agente de IA a conversa
 * que ficou com uma pessoa e passou do prazo sem nenhum sinal dela.
 *
 * Para cada organização que ligou o prazo em Configurações › Distribuição de
 * atendimento (`settings.routing.handoff_return_after_minutes`; desligado por
 * padrão), varre as conversas com humano de forma durável e devolve as
 * vencidas. A regra pura (quem vence, o que fica de fora, e por quê) mora em
 * `lib/escalacao/devolucao-automatica.ts`. Cada devolução passa por
 * `devolverAtendimentoAoAgente` — a MESMA função do botão e da tool do agente.
 *
 * Organização sem o prazo ligado: nada acontece.
 *
 * A cada 5 minutos: o prazo mínimo é 5 min, e cinco minutos de atraso sobre o
 * prazo escolhido não mudam nada para quem espera há uma hora.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed. Audita SÓ
 * quando devolveu (ou falhou) alguma — rodada vazia não é mutação.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #1133 de @Gervanno).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  lerPrazoDeDevolucaoMinutos,
  numerosComQuemAtenda,
  selecionarVencidas,
  type AgentePublicado,
  type ConversaEmHandoff,
  type NumeroDeclarado,
  type RoteadorAtivo,
} from "@/lib/escalacao/devolucao-automatica";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de conversas lidas por rodada; o que sobrar entra na próxima. */
const SCAN_LIMIT = 500;

const ATOR_DO_CRON = { type: "webhook_source", id: "cron:handoff-devolucao" } as const;

export interface DevolucaoResultado {
  organizacoes: number;
  examinadas: number;
  devolvidas: number;
  falhas: number;
}

async function prazosPorOrganizacao(admin: SupabaseClient): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from("organizations")
    .select("id, settings")
    .not("settings->routing->handoff_return_after_minutes", "is", null);
  if (error) throw new Error(`organizations: ${error.message}`);
  const prazos = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ id: string; settings: unknown }>) {
    const minutos = lerPrazoDeDevolucaoMinutos(row.settings);
    if (minutos !== null) prazos.set(row.id, minutos);
  }
  return prazos;
}

async function sessoesComAgente(
  admin: SupabaseClient,
  orgIds: string[],
): Promise<Map<string, Set<string>>> {
  const { data: agentesData, error: erroAgentes } = await admin
    .from("ai_agents")
    .select(
      "id, organization_id, versao:ai_agent_versions!ai_agents_published_version_id_fkey(channel_session_id, status)",
    )
    .in("organization_id", orgIds)
    .is("archived_at", null)
    .not("published_version_id", "is", null);
  if (erroAgentes) throw new Error(`ai_agents: ${erroAgentes.message}`);
  type Versao = { channel_session_id: string | null; status: string };
  const agentes: AgentePublicado[] = [];
  // O embed many-to-one volta como OBJETO em runtime; os tipos gerados dizem lista.
  for (const a of (agentesData ?? []) as unknown as Array<{
    id: string;
    organization_id: string;
    versao: Versao | Versao[] | null;
  }>) {
    const v = Array.isArray(a.versao) ? (a.versao[0] ?? null) : a.versao;
    if (v && v.status === "published") {
      agentes.push({ id: a.id, organization_id: a.organization_id, channel_session_id: v.channel_session_id });
    }
  }

  const { data: roteadoresData, error: erroRoteadores } = await admin
    .from("ai_routers")
    .select("id, organization_id, channel_session_id, fallback_agent_id, membros:ai_router_members(agent_id)")
    .in("organization_id", orgIds)
    .eq("is_active", true);
  if (erroRoteadores) throw new Error(`ai_routers: ${erroRoteadores.message}`);
  const roteadores: RoteadorAtivo[] = (
    (roteadoresData ?? []) as unknown as Array<{
      organization_id: string;
      channel_session_id: string | null;
      fallback_agent_id: string | null;
      membros: Array<{ agent_id: string }> | null;
    }>
  ).map((r) => ({
    organization_id: r.organization_id,
    channel_session_id: r.channel_session_id,
    agent_ids: [
      ...(r.fallback_agent_id ? [r.fallback_agent_id] : []),
      ...(r.membros ?? []).map((m) => m.agent_id),
    ],
  }));

  const { data: declaradosData, error: erroDeclarados } = await admin
    .from("ai_agent_channel_sessions")
    .select("agent_id, channel_session_id")
    .in("organization_id", orgIds);
  if (erroDeclarados) throw new Error(`ai_agent_channel_sessions: ${erroDeclarados.message}`);

  return numerosComQuemAtenda(agentes, roteadores, (declaradosData ?? []) as NumeroDeclarado[]);
}

export async function devolverHandoffsVencidos(
  admin: SupabaseClient,
  requestId: string,
  agora: Date = new Date(),
): Promise<DevolucaoResultado> {
  const prazoPorOrg = await prazosPorOrganizacao(admin);
  if (prazoPorOrg.size === 0) return { organizacoes: 0, examinadas: 0, devolvidas: 0, falhas: 0 };
  const orgIds = [...prazoPorOrg.keys()];

  const { data, error } = await admin
    .from("conversations")
    .select(
      "id, organization_id, channel_session_id, status, assignee_kind, assigned_to_user_id, assigned_at, bot_silenced_until, last_handoff_at, last_outbound_at, status_changed_at, contacts!conversations_contact_id_fkey(is_blocked, ai_opt_out)",
    )
    .in("organization_id", orgIds)
    .in("status", ["open", "pending", "claimed", "ai_handling"])
    .or("bot_silenced_until.eq.infinity,assignee_kind.eq.user,assigned_to_user_id.not.is.null")
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`conversations: ${error.message}`);
  const conversas = (data ?? []) as unknown as ConversaEmHandoff[];

  const vencidas = selecionarVencidas(conversas, {
    prazoPorOrg,
    sessoesComAgente: await sessoesComAgente(admin, orgIds),
    agoraMs: agora.getTime(),
  });

  let devolvidas = 0;
  let falhas = 0;
  for (const { conversa, minutos } of vencidas) {
    const r = await devolverAtendimentoAoAgente(
      { supabase: admin, organizationId: conversa.organization_id, actor: ATOR_DO_CRON, requestId },
      { conversationId: conversa.id, origem: { automatica: { minutos } } },
    );
    if (r.ok) {
      devolvidas++;
      continue;
    }
    // Corrida benigna: alguém assumiu entre a leitura e a escrita (o UPDATE casou
    // 0 linhas e volta SEM `detalhe`) — a pessoa ganhou. Os outros pontos que
    // devolvem `assignment_conflict` carregam a mensagem do banco e são falha
    // de verdade. A marca "sempre humano" lida agora (corrida com a tela) também
    // não é falha: é a recusa certa.
    if (r.erro === "assignment_conflict" && r.detalhe === undefined) continue;
    if (r.erro === "contato_sempre_humano") continue;
    falhas++;
    logger.error("[handoff-devolucao] devolução falhou", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      erro: r.erro,
      detalhe: r.detalhe,
      requestId,
    });
  }

  return { organizacoes: prazoPorOrg.size, examinadas: conversas.length, devolvidas, falhas };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: DevolucaoResultado;
  try {
    resultado = await devolverHandoffsVencidos(createAdminClient(), requestId);
  } catch (err) {
    logger.error("[handoff-devolucao] varredura falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Failed to scan conversations.", 500, { requestId });
  }

  // Cada devolução já audita por conversa (`ai.reactivated_by_agent`). A linha
  // da rodada diz que foi o prazo — e só existe quando houve efeito.
  if (resultado.devolvidas > 0 || resultado.falhas > 0) {
    void audit({
      action: "conversation.handoff_auto_return_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...resultado },
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
