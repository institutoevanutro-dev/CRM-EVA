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
 * SEGUNDA PASSADA — o cliente que escreveu durante a pausa por resposta humana
 * (`bot_silenced_until` finito) e ficou sem resposta: com
 * `settings.atendimento.pausa_cliente_sem_resposta_min` ligado (desligado por
 * padrão), passados N minutos sem ninguém responder, devolve a conversa ao
 * agente pela MESMA função e pede de novo o despacho da mensagem pendente
 * (`pedirDespachoDoAgente`). O pedido é necessário: o despacho original dela foi
 * descartado pelo drain, que não enfileira turno de conversa silenciada — e
 * `devolverAtendimentoAoAgente` só solta as travas, não responde ninguém.
 * Não retoma mensagem mais velha que `pausa_cliente_sem_resposta_max_horas`
 * (padrão 4 h) nem a que é só despedida (figurinha, reação, "obrigada"): a
 * primeira rodada em produção (4.30.0) retomou 12 conversas, 10 despedidas.
 *
 * COM `settings.atendimento.ia_volta_apos_equipe = "fim_do_dia_seguinte"`
 * (desligado por padrão): a equipe que falou segura a conversa até o fim do dia
 * seguinte. A primeira passada não devolve antes disso (`esperaDaEquipeMs`), e
 * a segunda não retoma: abre um aviso na Central (kind `other`, um por
 * mensagem pendente) para alguém responder ou clicar "Devolver ao automático".
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
import { pedirDespachoDoAgente } from "@/lib/channels/pos-entrada";
import {
  lerPrazoDeDevolucaoMinutos,
  numerosComQuemAtenda,
  avaliarRetomadaPorClienteSemResposta,
  selecionarClientesSemResposta,
  selecionarVencidas,
  type AgentePublicado,
  type ConversaEmHandoff,
  type ConversaEmPausa,
  type NumeroDeclarado,
  type RoteadorAtivo,
} from "@/lib/escalacao/devolucao-automatica";
import {
  lerClienteSemRespostaMaxHoras,
  lerClienteSemRespostaMin,
  lerIaVoltaAposEquipe,
} from "@/lib/escalacao/pausa-por-resposta-humana";
import { partesNoFuso } from "@/lib/agenda/fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { devolverAtendimentoAoAgente, type RetomadaResultado } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de conversas lidas por rodada; o que sobrar entra na próxima. */
const SCAN_LIMIT = 500;

/** Mensagens pendentes lidas por conversa retomável, para a regra da despedida. */
const PENDENTES_LIDAS = 10;

const ATOR_DO_CRON = { type: "webhook_source", id: "cron:handoff-devolucao" } as const;

export interface DevolucaoResultado {
  organizacoes: number;
  examinadas: number;
  devolvidas: number;
  falhas: number;
}

export interface RetomadaNaPausaResultado {
  organizacoes: number;
  examinadas: number;
  retomadas: number;
  /** Com `ia_volta_apos_equipe` ligado: avisos abertos na Central em vez de retomar. */
  avisos: number;
  /** Selecionadas cuja última mensagem era só despedida (figurinha, "obrigada"): ficaram na pausa. */
  despedidas: number;
  falhas: number;
}

/**
 * Corrida benigna: alguém assumiu entre a leitura e a escrita (o UPDATE casou
 * 0 linhas e volta SEM `detalhe`) — a pessoa ganhou. Os outros pontos que
 * devolvem `assignment_conflict` carregam a mensagem do banco e são falha de
 * verdade. A marca "sempre humano" lida agora (corrida com a tela) também não
 * é falha: é a recusa certa.
 */
function recusaBenigna(r: Extract<RetomadaResultado, { ok: false }>): boolean {
  return (r.erro === "assignment_conflict" && r.detalhe === undefined) || r.erro === "contato_sempre_humano";
}

type LinhaDaOrganizacao = { id: string; settings: unknown; timezone?: string | null };

/** `atendimento.ia_volta_apos_equipe` ligado nesta linha → o fuso dela. */
function anotarFimDoDiaSeguinte(row: LinhaDaOrganizacao, fusos: Map<string, string>): void {
  if (lerIaVoltaAposEquipe(row.settings) !== null) fusos.set(row.id, fusoUtilizavel(row.timezone));
}

async function prazosPorOrganizacao(
  admin: SupabaseClient,
): Promise<{ prazos: Map<string, number>; fusos: Map<string, string> }> {
  const { data, error } = await admin
    .from("organizations")
    .select("id, settings, timezone")
    .not("settings->routing->handoff_return_after_minutes", "is", null);
  if (error) throw new Error(`organizations: ${error.message}`);
  const prazos = new Map<string, number>();
  const fusos = new Map<string, string>();
  for (const row of (data ?? []) as LinhaDaOrganizacao[]) {
    const minutos = lerPrazoDeDevolucaoMinutos(row.settings);
    if (minutos !== null) prazos.set(row.id, minutos);
    anotarFimDoDiaSeguinte(row, fusos);
  }
  return { prazos, fusos };
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
  const { prazos: prazoPorOrg, fusos: fusoDoFimDoDiaSeguinte } = await prazosPorOrganizacao(admin);
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
    fusoDoFimDoDiaSeguinte,
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
    if (recusaBenigna(r)) continue;
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

async function esperasPorOrganizacao(
  admin: SupabaseClient,
): Promise<{ esperas: Map<string, number>; maxHoras: Map<string, number>; fusos: Map<string, string> }> {
  const { data, error } = await admin
    .from("organizations")
    .select("id, settings, timezone")
    .not("settings->atendimento->pausa_cliente_sem_resposta_min", "is", null);
  if (error) throw new Error(`organizations: ${error.message}`);
  const esperas = new Map<string, number>();
  const maxHoras = new Map<string, number>();
  const fusos = new Map<string, string>();
  for (const row of (data ?? []) as LinhaDaOrganizacao[]) {
    const minutos = lerClienteSemRespostaMin(row.settings);
    if (minutos === null) continue;
    esperas.set(row.id, minutos);
    maxHoras.set(row.id, lerClienteSemRespostaMaxHoras(row.settings));
    anotarFimDoDiaSeguinte(row, fusos);
  }
  return { esperas, maxHoras, fusos };
}

/** Título fixo: é também a chave de deduplicação do aviso. */
export const TITULO_DO_AVISO_DE_CLIENTE_SEM_RESPOSTA = "Cliente escreveu e ninguém da equipe respondeu";

/**
 * Com `atendimento.ia_volta_apos_equipe` ligado, a conversa em que o cliente
 * escreveu durante a pausa NÃO volta à IA: vira aviso na Central. Um por
 * mensagem pendente: já existe aviso desta conversa criado depois da última
 * saída → não abre outro. Devolve se abriu.
 */
async function avisarClienteSemResposta(
  admin: SupabaseClient,
  conversa: ConversaEmPausa,
  fuso: string,
  minutos: number,
  requestId: string,
): Promise<"aberto" | "ja_avisado" | "falhou"> {
  let jaExiste = admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", conversa.organization_id)
    .eq("kind", "other")
    .eq("ref_kind", "conversation")
    .eq("ref_id", conversa.id)
    .eq("title", TITULO_DO_AVISO_DE_CLIENTE_SEM_RESPOSTA);
  if (conversa.last_outbound_at) jaExiste = jaExiste.gt("created_at", conversa.last_outbound_at);
  const { data: existentes, error: lerErr } = await jaExiste.limit(1);
  if (lerErr) {
    logger.error("[handoff-devolucao] leitura do aviso falhou", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      detalhe: lerErr.message,
      requestId,
    });
    return "falhou";
  }
  if ((existentes ?? []).length > 0) return "ja_avisado";

  // Texto GRAVADO no aviso (não é interface): dia e hora no fuso da organização.
  const dois = (v: number) => String(v).padStart(2, "0");
  const ate =
    conversa.bot_silenced_until && conversa.bot_silenced_until !== "infinity"
      ? partesNoFuso(new Date(conversa.bot_silenced_until), fuso)
      : null;
  const volta = ate ? `${dois(ate.dia)}/${dois(ate.mes)} às ${dois(ate.hora)}:${dois(ate.minuto)}` : null;
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: conversa.organization_id,
    kind: "other",
    severity: "warn",
    title: TITULO_DO_AVISO_DE_CLIENTE_SEM_RESPOSTA,
    body:
      `O cliente espera há mais de ${minutos} minutos. A IA está fora desta conversa porque a equipe já falou` +
      (volta ? ` e só volta sozinha em ${volta}.` : ".") +
      ` Responda o cliente ou use "Devolver ao automático" na conversa.`,
    ref_kind: "conversation",
    ref_id: conversa.id,
  });
  if (error) {
    logger.error("[handoff-devolucao] aviso de cliente sem resposta falhou", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      detalhe: error.message,
      requestId,
    });
    return "falhou";
  }
  return "aberto";
}

/** A segunda passada: o cliente que escreveu durante a pausa e ficou sem resposta. */
export async function retomarClientesSemRespostaNaPausa(
  admin: SupabaseClient,
  requestId: string,
  agora: Date = new Date(),
): Promise<RetomadaNaPausaResultado> {
  const { esperas: esperaPorOrg, maxHoras: maxHorasPorOrg, fusos } = await esperasPorOrganizacao(admin);
  if (esperaPorOrg.size === 0) {
    return { organizacoes: 0, examinadas: 0, retomadas: 0, avisos: 0, despedidas: 0, falhas: 0 };
  }
  const orgIds = [...esperaPorOrg.keys()];

  // Só a pausa FINITA e vigente, sem dono humano; a regra pura confere o resto.
  const { data, error } = await admin
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, status, assignee_kind, assigned_to_user_id, assigned_at, bot_silenced_until, last_handoff_at, last_handoff_reason, last_inbound_at, last_outbound_at, awaiting_since, status_changed_at, contacts!conversations_contact_id_fkey(is_blocked, ai_opt_out, force_human)",
    )
    .in("organization_id", orgIds)
    .in("status", ["open", "pending", "claimed", "ai_handling"])
    .is("assigned_to_user_id", null)
    .gt("bot_silenced_until", agora.toISOString())
    .neq("bot_silenced_until", "infinity")
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`conversations: ${error.message}`);
  const conversas = (data ?? []) as unknown as ConversaEmPausa[];

  const selecao = {
    esperaPorOrg,
    maxHorasPorOrg,
    sessoesComAgente: await sessoesComAgente(admin, orgIds),
    agoraMs: agora.getTime(),
    avisarEmVezDeRetomar: new Set(fusos.keys()),
  };
  // Primeiro o filtro sem consulta; só quem passou tem a última mensagem lida.
  const selecionadas = selecionarClientesSemResposta(conversas, selecao);

  let retomadas = 0;
  let avisos = 0;
  let despedidas = 0;
  let falhas = 0;
  for (const { conversa, minutos, avisar } of selecionadas) {
    // As mensagens do cliente depois da última saída, a mais nova primeiro (a
    // mesma ordem do anti-backlog do drain, que só aceita o despacho da
    // última). Lidas ANTES de decidir: se TODAS forem despedida ("obrigada",
    // figurinha), a conversa fica na pausa; "qual o horário?" seguido de
    // "obrigada" ainda espera resposta. Teto de 10 por conversa.
    let consulta = admin
      .from("messages")
      .select("id, type, body")
      .eq("organization_id", conversa.organization_id)
      .eq("conversation_id", conversa.id)
      .eq("direction", "inbound");
    if (conversa.last_outbound_at) consulta = consulta.gt("created_at", conversa.last_outbound_at);
    const { data: msgs, error: msgErr } = await consulta
      .order("sent_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(PENDENTES_LIDAS);
    const pendentes = (msgs ?? []) as Array<{ id: string; type: string | null; body: string | null }>;
    const ultima = pendentes[0];
    // Lista vazia com `last_inbound_at > last_outbound_at` é leitura
    // inconsistente: sem a mensagem não há o que despachar, então é falha e a
    // conversa segue na pausa (a próxima rodada tenta de novo).
    if (msgErr || ultima === undefined) {
      falhas++;
      logger.error("[handoff-devolucao] mensagem pendente ilegível — conversa segue na pausa", {
        conversation_id: conversa.id,
        organization_id: conversa.organization_id,
        detalhe: msgErr?.message ?? "sem inbound depois da última saída",
        requestId,
      });
      continue;
    }
    const decisao = avaliarRetomadaPorClienteSemResposta(conversa, selecao, pendentes);
    if (!decisao.retomar && !decisao.avisar) {
      despedidas++;
      continue;
    }
    // A equipe já falou e a organização ligou o "fim do dia seguinte": a IA
    // não volta antes disso. Quem esperava resposta vira aviso, não retomada.
    if (avisar) {
      const r = await avisarClienteSemResposta(
        admin,
        conversa,
        fusos.get(conversa.organization_id) ?? fusoUtilizavel(null),
        minutos,
        requestId,
      );
      if (r === "aberto") avisos++;
      else if (r === "falhou") falhas++;
      continue;
    }

    const r = await devolverAtendimentoAoAgente(
      { supabase: admin, organizationId: conversa.organization_id, actor: ATOR_DO_CRON, requestId },
      { conversationId: conversa.id, origem: { automatica: { minutos } } },
    );
    if (!r.ok) {
      if (recusaBenigna(r)) continue;
      falhas++;
      logger.error("[handoff-devolucao] retomada na pausa falhou", {
        conversation_id: conversa.id,
        organization_id: conversa.organization_id,
        erro: r.erro,
        detalhe: r.detalhe,
        requestId,
      });
      continue;
    }

    const messageId = ultima.id;
    const pedido =
      conversa.contact_id !== null &&
      conversa.channel_session_id !== null &&
      (await pedirDespachoDoAgente(admin as Parameters<typeof pedirDespachoDoAgente>[0], {
        organizationId: conversa.organization_id,
        contactId: conversa.contact_id,
        conversationId: conversa.id,
        messageId,
        channelSessionId: conversa.channel_session_id,
        texto: null,
        nomeDoContato: null,
        requestId,
        origem: "cron:handoff-devolucao",
      }));
    if (pedido) {
      retomadas++;
      continue;
    }
    // A conversa JÁ voltou ao agente; a próxima mensagem do cliente será
    // respondida. Esta ficou sem — é falha, e aparece na rodada.
    falhas++;
    logger.error("[handoff-devolucao] retomou, mas o despacho da mensagem pendente falhou", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      detalhe: "emit falhou",
      requestId,
    });
  }

  return { organizacoes: esperaPorOrg.size, examinadas: conversas.length, retomadas, avisos, despedidas, falhas };
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
  let naPausa: RetomadaNaPausaResultado;
  try {
    const admin = createAdminClient();
    resultado = await devolverHandoffsVencidos(admin, requestId);
    naPausa = await retomarClientesSemRespostaNaPausa(admin, requestId);
  } catch (err) {
    logger.error("[handoff-devolucao] varredura falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Failed to scan conversations.", 500, { requestId });
  }

  // Cada devolução já audita por conversa (`ai.reactivated_by_agent`). A linha
  // da rodada diz que foi o prazo — e só existe quando houve efeito.
  if (
    resultado.devolvidas > 0 ||
    resultado.falhas > 0 ||
    naPausa.retomadas > 0 ||
    naPausa.avisos > 0 ||
    naPausa.falhas > 0
  ) {
    void audit({
      action: "conversation.handoff_auto_return_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...resultado, cliente_sem_resposta_na_pausa: { ...naPausa } },
      requestId,
    });
  }

  return ok({ ...resultado, cliente_sem_resposta_na_pausa: naPausa }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
