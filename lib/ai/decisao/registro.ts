/**
 * O QUE O JEV DEIXA GRAVADO: a chamada em `llm_calls` (custo e latência em IA ›
 * Execuções e no gasto do mês) e cada resposta em `jev_observacoes` (só rótulo
 * e probabilidade — nunca texto do cliente).
 *
 * Escreve só nessas duas tabelas; o aviso de "Avisar a equipe" é de
 * `./aviso-a-equipe.ts` (cerca em
 * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`). Nunca lança:
 * observação perdida não pode derrubar o worker de clima.
 */
import {
  avisarFalhaDoProvedor,
  bancoPeloAdmin,
  fecharAvisosDoProvedor,
  PROVEDOR_DO_JEV,
} from "@/lib/agent-engine/edge/llm/aviso-do-provedor";
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
      provider: PROVEDOR_DO_JEV,
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
    // Chave recusada e conta sem crédito não passam sozinhas: aviso na Central,
    // que se fecha quando o Jev volta a responder. As duas funções nunca lançam.
    const alvo = { organizationId: c.organizationId, provedor: PROVEDOR_DO_JEV };
    if (r.ok) await fecharAvisosDoProvedor(bancoPeloAdmin(admin), alvo, logger);
    else if (r.motivo === "credencial_invalida" || r.motivo === "sem_credito") {
      const motivo = r.motivo === "sem_credito" ? "sem_saldo" : "chave_recusada";
      await avisarFalhaDoProvedor(bancoPeloAdmin(admin), { ...alvo, motivo }, logger);
    }
  } catch (erro) {
    logger.warn("[jev] linha de custo falhou", {
      organization_id: c.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
}

export interface Observacao {
  tarefa: IdDaTarefa;
  /** O estado da tarefa quando o Jev respondeu. */
  estado: "observando" | "decidindo";
  rotuloJev: string | null;
  probabilidadeJev: number | null;
  confiancaJev: number | null;
  /** O que o mecanismo de hoje decidiu. `null` = não decidiu (sem par). */
  rotuloAtual: string | null;
  modelo: string;
  latenciaMs: number | null;
}

/**
 * Uma linha por tarefa e mensagem; o retry do evento cai no índice único e é
 * ignorado. Devolve `false` SÓ nesse caso (23505): a primeira execução já
 * decidiu o aviso, e uma segunda reabriria o que alguém acabou de resolver.
 * Observação perdida por outro motivo não tem retry, e o Jev disse o que disse.
 */
export async function registrarObservacao(admin: Admin, c: Contexto, o: Observacao): Promise<boolean> {
  try {
    const { error } = await admin.from("jev_observacoes").insert({
      organization_id: c.organizationId,
      tarefa: o.tarefa,
      estado: o.estado,
      conversation_id: c.conversationId,
      message_id: c.messageId,
      rotulo_jev: o.rotuloJev,
      probabilidade_jev: o.probabilidadeJev,
      confianca_jev: o.confiancaJev,
      rotulo_atual: o.rotuloAtual,
      modelo: o.modelo,
      latencia_ms: o.latenciaMs,
    });
    if (error?.code === "23505") return false;
    if (error) logger.warn("[jev] observação não gravada", { organization_id: c.organizationId, erro: error.code });
  } catch (erro) {
    logger.warn("[jev] observação falhou", {
      organization_id: c.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
  return true;
}
