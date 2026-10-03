/**
 * Contratos das rotas de respostas prontas (Zod em todo input externo). Puro:
 * sem banco.
 */
import { z } from "zod";

import { LIMITE_MAXIMO, LIMITE_MINIMO } from "./casamento";

const perguntas = z
  .array(z.string().trim().min(3).max(200))
  .min(1)
  .max(20)
  .transform((lista) => [...new Set(lista)]);

export const criarRespostaProntaSchema = z
  .object({
    titulo: z.string().trim().min(1).max(80),
    resposta: z.string().trim().min(1).max(1000),
    perguntas,
  })
  .strict();

export const editarRespostaProntaSchema = z
  .object({
    titulo: z.string().trim().min(1).max(80).optional(),
    resposta: z.string().trim().min(1).max(1000).optional(),
    perguntas: perguntas.optional(),
    ativo: z.boolean().optional(),
    revisado: z.literal(true).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "nada para alterar" });

export const configRespostasProntasSchema = z
  .object({
    ligado: z.boolean(),
    limite_similaridade: z.number().min(LIMITE_MINIMO).max(LIMITE_MAXIMO),
  })
  .strict();

export const metricasQuerySchema = z.object({
  dias: z.enum(["7", "30", "90"]).default("30").transform(Number),
});

export interface MetricasRespostasProntas {
  resolvidas_por_resposta_pronta: number;
  respondidas_pela_ia: number;
  /** Centavos de US$ (`llm_calls.cost_cents`). null = sem turno de IA no período. */
  custo_medio_turno_cents: number | null;
  custo_evitado_estimado_cents: number | null;
  /** Alguma chamada sem preço conhecido: o custo fica ABAIXO do real. */
  custo_incompleto: boolean;
}

/**
 * A conta sobre o agregado que o banco devolve (`fn_respostas_prontas_metricas`).
 * "Respondidas pela IA" = jobs distintos com chamada `agent_turn` no período
 * (inclui follow-up — por isso a tela diz "estimado"). Custo evitado = resolvidas
 * × custo médio por turno de IA do mesmo período.
 */
export function resumirAgregado(
  usos: number,
  turnos: number,
  custoTotalCents: number | string,
  custoIncompleto: boolean,
): MetricasRespostasProntas {
  const medio = turnos > 0 ? Number(custoTotalCents) / turnos : null;
  return {
    resolvidas_por_resposta_pronta: usos,
    respondidas_pela_ia: turnos,
    custo_medio_turno_cents: medio,
    custo_evitado_estimado_cents: medio === null ? null : medio * usos,
    custo_incompleto: custoIncompleto,
  };
}

/** Mesma conta a partir de chamadas soltas (cost_cents null = preço desconhecido). */
export function resumirMetricas(
  usos: number,
  chamadas: ReadonlyArray<{ job_id: string | null; cost_cents: number | string | null }>,
): MetricasRespostasProntas {
  const jobs = new Set<string>();
  let total = 0;
  let incompleto = false;
  for (const c of chamadas) {
    if (c.job_id === null) continue;
    jobs.add(c.job_id);
    const valor = c.cost_cents === null ? Number.NaN : Number(c.cost_cents);
    if (Number.isFinite(valor)) total += valor;
    else incompleto = true;
  }
  return resumirAgregado(usos, jobs.size, total, incompleto);
}
