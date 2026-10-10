/**
 * O QUE O JEV DEIXA GRAVADO: a chamada em `llm_calls` (custo e latência em IA ›
 * Execuções e no gasto do mês) e cada resposta em `jev_observacoes` (só rótulo
 * e probabilidade — nunca texto do cliente).
 *
 * Escreve só nessas duas tabelas (cerca em
 * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`). Nunca lança:
 * observação perdida não pode derrubar o worker de clima.
 */
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

import { MODELO_DO_JEV, type ResultadoDaDecisao } from "./cliente";
import type { IdDaTarefa } from "./config";

type Admin = ReturnType<typeof createAdminClient>;

/** US$ 0,042 por milhão de tokens de entrada, saída grátis (preço do upstream, #1575). Em centavos. */
export const CENTAVOS_POR_TOKEN_DE_ENTRADA = (0.042 * 100) / 1_000_000;

export interface Contexto {
  organizationId: string;
  conversationId: string | null;
  messageId: string;
  agentId: string | null;
}

/** Uma linha em `llm_calls` por pergunta que SAIU para a rede, com sucesso ou não. */
export async function registrarChamada(admin: Admin, c: Contexto, r: ResultadoDaDecisao): Promise<void> {
  try {
    const tokens = r.ok ? r.uso.tokensDeEntrada : 0;
    const { error } = await admin.from("llm_calls").insert({
      organization_id: c.organizationId,
      agent_id: c.agentId,
      purpose: "sentiment_classify",
      provider: "typesafe",
      model: r.ok ? r.modelo : MODELO_DO_JEV,
      input_tokens: tokens,
      output_tokens: r.ok ? r.uso.tokensDeSaida : 0,
      cost_cents: tokens * CENTAVOS_POR_TOKEN_DE_ENTRADA,
      latency_ms: r.latenciaMs ?? null,
      status: r.ok ? "ok" : "erro",
      error_code: r.ok ? null : `jev_${r.motivo}`,
      http_status: r.ok ? null : r.status,
    });
    if (error) logger.warn("[jev] linha de custo não gravada", { organization_id: c.organizationId, erro: error.code });
  } catch (erro) {
    logger.warn("[jev] linha de custo falhou", {
      organization_id: c.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
}

export interface Observacao {
  tarefa: IdDaTarefa;
  rotuloJev: string | null;
  probabilidadeJev: number | null;
  confiancaJev: number | null;
  /** O que o mecanismo de hoje decidiu. `null` = não decidiu (sem par). */
  rotuloAtual: string | null;
  modelo: string;
  latenciaMs: number | null;
}

/** Uma linha por tarefa e mensagem; o retry do evento cai no índice único e é ignorado. */
export async function registrarObservacao(admin: Admin, c: Contexto, o: Observacao): Promise<void> {
  try {
    const { error } = await admin.from("jev_observacoes").insert({
      organization_id: c.organizationId,
      tarefa: o.tarefa,
      estado: "observando",
      conversation_id: c.conversationId,
      message_id: c.messageId,
      rotulo_jev: o.rotuloJev,
      probabilidade_jev: o.probabilidadeJev,
      confianca_jev: o.confiancaJev,
      rotulo_atual: o.rotuloAtual,
      modelo: o.modelo,
      latencia_ms: o.latenciaMs,
    });
    if (error && error.code !== "23505") {
      logger.warn("[jev] observação não gravada", { organization_id: c.organizationId, erro: error.code });
    }
  } catch (erro) {
    logger.warn("[jev] observação falhou", {
      organization_id: c.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
}
