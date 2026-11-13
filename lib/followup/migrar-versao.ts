/**
 * Levar as inscrições VIVAS de um fluxo para a versão ATIVA.
 *
 * A inscrição fixa `version_id` ao começar e o motor (`engine.ts` →
 * `processEnrollment`) relê o grafo DESSA versão a cada passo: acha o nó por
 * `current_node_id` e escolhe a aresta seguinte em `graph.edges`. Publicar
 * versão nova não alcança quem já está andando — o texto novo (com
 * `{{primeiro_nome}}`, por exemplo) só chega a quem entra depois.
 *
 * Trocar `version_id` faz o PRÓXIMO passo sair do grafo novo a partir do mesmo
 * `current_node_id`. A história (`followup_enrollment_events`) é chaveada por id
 * de nó, então a fase da espera (`resolveWaitPhase`) continua valendo — desde
 * que o nó atual exista na versão ativa com o mesmo tipo e o mesmo relógio.
 * `avaliaMigracao` é essa regra; a operação só troca o ponteiro.
 *
 * O que a operação NÃO toca: `status`, `next_eval_at` e `updated_at`. Este
 * último é o piso da leitura da resposta no `match_reply`/`ai_classify`
 * (`pisoDoInboundDaEspera`): movê-lo para agora esconderia do motor uma
 * resposta que o paciente já mandou. Nada é enviado no ato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { flowGraphSchema, type FlowGraph, type FlowNode } from "./graph-schema";

/** Os mesmos quatro do índice único de inscrição viva (`idx_followup_enrollments_one_live`). */
export const STATUS_VIVOS_DA_MIGRACAO = ["active", "waiting_reply", "paused_handoff", "paused_manual"] as const;

export type MotivoInseguro =
  | "no_ausente_na_origem"
  | "no_ausente_na_ativa"
  | "tipo_diferente"
  | "espera_diferente"
  | "prazo_de_resposta_diferente"
  | "versao_ilegivel";

export type Avaliacao = { seguro: true } | { seguro: false; motivo: MotivoInseguro };

/** O que define QUANDO o nó volta a ser avaliado — o sentido de `next_eval_at`. */
function relogioDo(no: FlowNode): string | null {
  if (no.type === "wait") {
    const c = no.config;
    return c.mode === "fixed" ? `fixed:${c.duration_ms}:${c.anchor ?? ""}` : `smart:${c.min_ms}:${c.max_ms}`;
  }
  if (no.type === "match_reply" || no.type === "ai_classify") return String(no.config.grace_timeout_ms);
  return null;
}

/**
 * Seguro = o nó atual existe na versão ativa com o MESMO tipo e, se ele tem
 * relógio (espera, prazo de resposta), o mesmo relógio: `next_eval_at` foi
 * calculado pela config antiga e não é recalculado na migração.
 */
export function avaliaMigracao(origem: FlowGraph, ativa: FlowGraph, noAtual: string): Avaliacao {
  const antes = origem.nodes.find((n) => n.id === noAtual);
  if (!antes) return { seguro: false, motivo: "no_ausente_na_origem" };
  const depois = ativa.nodes.find((n) => n.id === noAtual);
  if (!depois) return { seguro: false, motivo: "no_ausente_na_ativa" };
  if (antes.type !== depois.type) return { seguro: false, motivo: "tipo_diferente" };
  if (relogioDo(antes) !== relogioDo(depois)) {
    return { seguro: false, motivo: antes.type === "wait" ? "espera_diferente" : "prazo_de_resposta_diferente" };
  }
  return { seguro: true };
}

// ---------------------------------------------------------------------------
// A operação
// ---------------------------------------------------------------------------

export interface DepsDaMigracao {
  /**
   * Rota: client da SESSÃO (a RLS, manager+ no UPDATE, continua valendo).
   * Script de operação: service role — por isso TODA query aqui filtra
   * `organization_id` à mão.
   */
  supabase: SupabaseClient;
  /** Da sessão (`requireRole`) ou do operador no script; nunca do body. */
  orgId: string;
  /** Null quando quem roda é o script de operação, sem pessoa logada. */
  userId: string | null;
  requestId: string;
  agora?: Date;
}

export interface ContagemPorVersao {
  version_id: string;
  total: number;
  seguras: number;
  /** Seguras que de fato trocaram de versão (0 no dry-run). */
  migradas: number;
  /** Seguras que mudaram sob a operação (motor ocupado, passo andou): a próxima rodada pega. */
  adiadas: number;
  nao_seguras: Partial<Record<MotivoInseguro, number>>;
}

export type ResultadoDaMigracao =
  | {
      ok: true;
      dry_run: boolean;
      pointer_id: string;
      versao_ativa: string;
      por_versao: ContagemPorVersao[];
      totais: { total: number; seguras: number; migradas: number; adiadas: number; nao_seguras: number };
    }
  | { ok: false; codigo: "nao_encontrado" | "sem_versao_ativa" | "erro_interno"; mensagem: string };

type Linha = { id: string; version_id: string; current_node_id: string };

const PAGINA = 500;

export async function migraInscricoesParaVersaoAtiva(
  deps: DepsDaMigracao,
  pointerId: string,
  opcoes: { dryRun: boolean },
): Promise<ResultadoDaMigracao> {
  const { supabase, orgId } = deps;
  const agoraIso = (deps.agora ?? new Date()).toISOString();

  const { data: pointer, error: pErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, active_version_id")
    .eq("id", pointerId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pErr) return { ok: false, codigo: "erro_interno", mensagem: pErr.message };
  if (!pointer) return { ok: false, codigo: "nao_encontrado", mensagem: "Fluxo não encontrado." };
  const ativaId = pointer.active_version_id as string | null;
  if (!ativaId) return { ok: false, codigo: "sem_versao_ativa", mensagem: "Este fluxo ainda não tem versão publicada." };

  // Paginado por id: um pós-consulta de clínica grande passa do teto de linhas do PostgREST.
  const linhas: Linha[] = [];
  for (let ultimo = ""; ; ) {
    let q = supabase
      .from("followup_enrollments")
      .select("id, version_id, current_node_id")
      .eq("organization_id", orgId)
      .eq("pointer_id", pointerId)
      .neq("version_id", ativaId)
      .in("status", [...STATUS_VIVOS_DA_MIGRACAO]);
    if (ultimo) q = q.gt("id", ultimo);
    const { data, error } = await q.order("id").limit(PAGINA);
    if (error) return { ok: false, codigo: "erro_interno", mensagem: error.message };
    const pagina = (data ?? []) as Linha[];
    linhas.push(...pagina);
    if (pagina.length < PAGINA) break;
    ultimo = pagina[pagina.length - 1]!.id;
  }

  const grafos = new Map<string, FlowGraph | null>();
  const idsDeVersao = [...new Set([ativaId, ...linhas.map((l) => l.version_id)])];
  const { data: versoes, error: vErr } = await supabase
    .from("followup_flow_versions")
    .select("id, graph")
    .eq("organization_id", orgId)
    .in("id", idsDeVersao);
  if (vErr) return { ok: false, codigo: "erro_interno", mensagem: vErr.message };
  for (const v of (versoes ?? []) as Array<{ id: string; graph: unknown }>) {
    const g = flowGraphSchema.safeParse(v.graph);
    grafos.set(v.id, g.success ? g.data : null);
  }
  const ativa = grafos.get(ativaId);
  if (!ativa) return { ok: false, codigo: "erro_interno", mensagem: "A versão ativa do fluxo não pôde ser lida." };

  const porVersao = new Map<string, ContagemPorVersao>();
  for (const l of linhas) {
    let c = porVersao.get(l.version_id);
    if (!c) {
      c = { version_id: l.version_id, total: 0, seguras: 0, migradas: 0, adiadas: 0, nao_seguras: {} };
      porVersao.set(l.version_id, c);
    }
    c.total++;
    const origem = grafos.get(l.version_id);
    const avaliacao: Avaliacao = origem
      ? avaliaMigracao(origem, ativa, l.current_node_id)
      : { seguro: false, motivo: "versao_ilegivel" };
    if (!avaliacao.seguro) {
      c.nao_seguras[avaliacao.motivo] = (c.nao_seguras[avaliacao.motivo] ?? 0) + 1;
      continue;
    }
    c.seguras++;
    if (opcoes.dryRun) continue;

    // Guarda otimista: só troca se ninguém mexeu desde a leitura — mesma versão,
    // mesmo nó, ainda viva e fora do claim do motor. O que escapa fica para a
    // próxima rodada (a operação é idempotente: só pega quem não está na ativa).
    const { data: trocadas, error: uErr } = await supabase
      .from("followup_enrollments")
      .update({ version_id: ativaId })
      .eq("id", l.id)
      .eq("organization_id", orgId)
      .eq("version_id", l.version_id)
      .eq("current_node_id", l.current_node_id)
      .in("status", [...STATUS_VIVOS_DA_MIGRACAO])
      .or(`claimed_until.is.null,claimed_until.lt.${agoraIso}`)
      .select("id");
    if (uErr || (trocadas ?? []).length === 0) {
      if (uErr) {
        logger.warn("[followup.migrar-versao] inscrição não migrada", {
          erro: uErr.message,
          requestId: deps.requestId,
          enrollmentId: l.id,
        });
      }
      c.adiadas++;
      continue;
    }
    c.migradas++;

    const { error: eErr } = await supabase.from("followup_enrollment_events").insert({
      organization_id: orgId,
      enrollment_id: l.id,
      node_id: l.current_node_id,
      event_type: "version_migrated",
      payload: {
        from_version_id: l.version_id,
        to_version_id: ativaId,
        current_node_id: l.current_node_id,
        actor_user_id: deps.userId,
      },
    });
    // Sem idempotency_key: a guarda do UPDATE já garante um evento por troca real,
    // e uma chave fixa (origem:destino) engoliria o evento de uma ida-e-volta legítima.
    if (eErr) {
      logger.error("[followup.migrar-versao] evento não gravado", {
        erro: eErr.message,
        requestId: deps.requestId,
        enrollmentId: l.id,
      });
    }
  }

  const por_versao = [...porVersao.values()];
  const soma = (f: (c: ContagemPorVersao) => number) => por_versao.reduce((s, c) => s + f(c), 0);
  return {
    ok: true,
    dry_run: opcoes.dryRun,
    pointer_id: pointerId,
    versao_ativa: ativaId,
    por_versao,
    totais: {
      total: soma((c) => c.total),
      seguras: soma((c) => c.seguras),
      migradas: soma((c) => c.migradas),
      adiadas: soma((c) => c.adiadas),
      nao_seguras: soma((c) => c.total - c.seguras),
    },
  };
}
