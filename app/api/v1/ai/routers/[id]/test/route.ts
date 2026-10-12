import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/routers/:id/test — classifica uma mensagem de TESTE contra o
 * router (manager+). Reusa classifyIntent (mesmo seam de runtime) — NUNCA
 * grava em ai_router_decisions (telemetria de decisões reais de produção, não
 * de teste) nem em conversations.
 *
 * O roteador é carregado por id, ATIVO OU NÃO (`loadRouterById`): quem monta um
 * roteador precisa ver a classificação antes de ligá-lo no canal. Testar não
 * altera `is_active`.
 *
 * `contact_id` (opcional) faz o classificador receber os fatos da agenda desse
 * contato, como no turno real. Ele vem do CORPO, então a posse é conferida com
 * a organização da SESSÃO antes de qualquer leitura: contato de outra
 * organização é 404, e nenhum fato é lido. Contato anonimizado (LGPD) ou
 * mesclado em outro também é 404: a agenda dele não é mais de ninguém que a
 * tela deixe escolher.
 *
 * leadId/jobId vão null pro classificador: não existe contact/job real por
 * trás de um clique de teste na UI, e llm_calls.contact_id/job_id são FKs —
 * um uuid inventado quebraria o insert do registro de custo (ver
 * lib/agent-engine/agent/intent-classifier.ts).
 *
 * O match só conta se confidence >= min_confidence do router (mesma regra do
 * runtime, a do mínimo de confiança em resolve-turn-agent) — devolve min_confidence no payload pra
 * a tela explicar quando o resultado cairia no fallback/genérico em produção.
 *
 * CONVERSA SIMULADA. `current_intent` diz qual assunto está atendendo (tem de
 * ser membro do roteador) e `history` traz as mensagens de antes. Com eles a
 * rota responde o que `resolveTurnAgent` responderia para a mesma entrada, pela
 * MESMA regra (`mudouDeAssunto`) e na mesma ordem: o atalho que nem chama o
 * classificador (`classified: false`), a falha do classificador que mantém quem
 * está atendendo, e a troca. `kept_current` diz se a conversa ficaria com o
 * assunto atual; `agent_id` é sempre o agente FINAL. O `history` só vai ao
 * classificador no modo `permanencia: 'agente'`, como no turno real, e passa
 * pelo mesmo corte e achatamento (`emUmaLinha`). Nada disso é gravado.
 *
 * O que a rota NÃO simula: agente sem versão publicada (regra 7 do resolvedor)
 * e o agente de campanha (degrau 0). Ela diz quem o roteador escolheria.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { env } from "@/lib/env";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadRouterById } from "@/lib/agent-engine/agent/router-config";
import { buildFatosDoContato } from "@/lib/agent-engine/agent/fatos-do-contato";
import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { mudouDeAssunto } from "@/lib/agent-engine/agent/resolve-turn-agent";
import {
  MAXIMO_DE_MENSAGENS_NO_HISTORICO,
  emUmaLinha,
  renderHistoricoRecente,
} from "@/lib/agent-engine/agent/historico-recente";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const testSchema = z.object({
  message: z.string().min(1).max(4000),
  contact_id: z.string().uuid().optional(),
  history: z
    .array(z.object({ direction: z.enum(["inbound", "outbound"]), body: z.string().max(1000) }))
    .max(MAXIMO_DE_MENSAGENS_NO_HISTORICO)
    .optional(),
  current_intent: z.string().min(1).max(120).optional(),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = testSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const pool = getSkillsPool();
  let loaded: Awaited<ReturnType<typeof loadRouterById>>;
  try {
    loaded = await loadRouterById(pool, org.orgId, id);
  } catch {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!loaded) {
    return fail("not_found", t("Router não encontrado."), 404, { requestId });
  }

  // Quem está atendendo, na conversa simulada. Mesma leitura do resolvedor:
  // roteador sem permanência (`sticky` desligado) não segura ninguém.
  const assuntoAtual = parsed.data.current_intent ?? null;
  const membroAtual = assuntoAtual !== null ? loaded.members.find((m) => m.intentName === assuntoAtual) : undefined;
  if (assuntoAtual !== null && membroAtual === undefined) {
    return fail("validation_failed", t("O assunto atual não é um assunto deste roteador."), 422, { requestId });
  }
  const atual = loaded.sticky ? membroAtual : undefined;
  const comContexto = loaded.permanencia === "agente";

  const admin = createAdminClient();
  const log = createLogger();

  let fatos: string | null = null;
  const contactId = parsed.data.contact_id;
  if (contactId !== undefined) {
    const { data: contato, error: contatoErr } = await admin
      .from("contacts")
      .select("id, is_anonymized, is_merged_into")
      .eq("id", contactId)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (contatoErr) {
      return fail("internal_error", "Erro ao carregar contato.", 500, { requestId });
    }
    if (!contato || contato.is_anonymized || contato.is_merged_into !== null) {
      return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    }
    try {
      fatos = await buildFatosDoContato(pool, org.orgId, contactId, new Date());
    } catch (err) {
      // Mesma regra do turno real: sem fatos, classifica só com a mensagem.
      log.warn("router-test: fatos do contato indisponíveis — classificando só com a mensagem", {
        routerId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Atalho da regra 2b de resolve-turn-agent: sem assunto que possa
  // interromper, o veredito não muda nada, e o turno real nem classifica.
  const classificou = !(
    comContexto &&
    atual !== undefined &&
    !loaded.interrompe.some((i) => i !== atual.intentName && loaded.members.some((m) => m.intentName === i))
  );

  const historico = comContexto
    ? renderHistoricoRecente(
        (parsed.data.history ?? [])
          .map((m) => ({ direction: m.direction, texto: emUmaLinha(m.body) }))
          .filter((m) => m.texto !== ""),
      ) || null
    : null;

  const verdict = classificou
    ? await classifyIntent(
        pool,
        llmEdgeConfigFromEnv(env),
        {
          tenantId: org.orgId, leadId: null, jobId: null, router: loaded, signal: parsed.data.message, fatos,
          // Fora do modo novo as chaves nem existem: a entrada é a de antes.
          ...(comContexto ? { historico, assuntoAtual: atual?.intentName ?? null } : {}),
        },
        { log },
      )
    : null;

  // Com alguém atendendo: fica, a menos que `mudouDeAssunto` (a regra do turno
  // real). Classificador que falhou também mantém quem está (regra 4).
  const keptCurrent =
    atual !== undefined && (verdict === null || !mudouDeAssunto(loaded, atual.intentName, verdict));

  // Sem ninguém atendendo, a regra do mínimo de confiança: só casa a intenção se
  // a confiança bateu o mínimo do router; abaixo disso, produção cai no
  // fallback/genérico, e o painel de teste não pode fingir que casou.
  const matchedMember = keptCurrent
    ? atual
    : verdict?.intentName != null && verdict.confidence >= loaded.minConfidence
      ? loaded.members.find((m) => m.intentName === verdict.intentName)
      : undefined;
  const agentId = matchedMember?.agentId ?? loaded.fallbackAgentId;

  let agentName: string | null = null;
  if (agentId) {
    const { data: agentRow } = await admin
      .from("ai_agents")
      .select("name")
      .eq("id", agentId)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    agentName = agentRow?.name ?? null;
  }

  return ok(
    {
      intent_name: verdict?.intentName ?? null,
      confidence: verdict?.confidence ?? 0,
      min_confidence: loaded.minConfidence,
      agent_id: agentId,
      agent_name: agentName,
      fatos,
      mode: loaded.permanencia,
      kept_current: keptCurrent,
      classified: classificou,
    },
    { requestId },
  );
}
