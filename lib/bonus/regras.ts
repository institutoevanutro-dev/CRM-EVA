/**
 * A REGRA do bônus da equipe: esquema ÚNICO de `bonus_programas.regras`.
 *
 * Nenhum valor em dinheiro tem padrão diferente de zero: valores, metas e
 * participantes são da organização e só existem no banco dela. As quantidades
 * (30 leads, 5 ligações, 2 stories, 7h, 5% em 3 dias) são regra do produto.
 *
 * Frações e limites em pontos-base (10000 = 100%) para o cálculo não depender
 * de ponto flutuante: 90% exatos têm de pagar a faixa de 90%.
 */
import { z } from "zod";

import type { ChaveDeResultado } from "./tipos";

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const centavos = z.number().int().min(0).max(10_000_000);
const bps = z.number().int().min(0).max(10_000);
const inteiro = (min: number, max: number) => z.number().int().min(min).max(max);

const metaSchema = z
  .object({ basica: inteiro(0, 100_000), alta: inteiro(0, 100_000) })
  .refine((m) => m.alta >= m.basica, { message: "A meta alta não pode ser menor que a básica." });

const valorSchema = z.object({ valor_cents: centavos.default(0) }).prefault({});

export const regrasSchema = z.object({
  participantes: z.array(z.string().uuid()).max(20).default([]),
  teto_cents: centavos.nullable().default(null),
  tarefas: z
    .object({
      valor_cents: centavos.default(0),
      faixas: z
        .array(z.object({ minimo_bps: bps, fracao_bps: bps }))
        .max(5)
        .default([
          { minimo_bps: 10_000, fracao_bps: 10_000 },
          { minimo_bps: 9_000, fracao_bps: 5_000 },
        ]),
    })
    .prefault({}),
  rotinas: z
    .object({
      leads_por_dia: inteiro(0, 100).default(30),
      ligacoes_por_dia: inteiro(0, 30).default(5),
      stories_por_dia: inteiro(0, 20).default(2),
    })
    .prefault({}),
  resultados: z
    .object({ comparecimento: valorSchema, sinal_pago: valorSchema, avaliacao_google: valorSchema })
    .prefault({}),
  metas_por_mes: z
    .record(
      z.string().regex(MES),
      z.object({ comparecimento: metaSchema, sinal_pago: metaSchema, avaliacao_google: metaSchema }),
    )
    .default({}),
  meses_de_teste: z
    .record(z.string().regex(MES), z.object({ garantia_resultados_cents: centavos }))
    .default({}),
  feriados: z.array(z.string().regex(DIA)).max(60).default([]),
  fila: z
    .object({
      hora_local: inteiro(0, 11).default(7),
      dias_sem_mensagem: inteiro(1, 365).default(30),
      dias_sem_repetir: inteiro(1, 365).default(60),
      etiqueta_excluida: z.string().trim().max(40).default("reativacao"),
      ligacoes: z
        .object({
          dias_falta: inteiro(1, 90).default(30),
          dias_pos_consulta: inteiro(1, 30).default(7),
          dias_retorno_min: inteiro(1, 365).default(30),
          dias_retorno_max: inteiro(1, 730).default(90),
          dias_sem_repetir: inteiro(1, 365).default(30),
        })
        .prefault({}),
    })
    .prefault({}),
  protecao: z
    .object({
      limite_bps: bps.default(500),
      dias_seguidos: inteiro(1, 10).default(3),
      fracao_reduzida_bps: bps.default(5_000),
    })
    .prefault({}),
});

export type RegrasDoBonus = z.infer<typeof regrasSchema>;
export type MetasDoMes = Record<ChaveDeResultado, { basica: number; alta: number }>;

export const REGRAS_PADRAO: RegrasDoBonus = regrasSchema.parse({});

/** Lê o jsonb do banco sem lançar: regra torta devolve o caminho do primeiro erro. */
export function lerRegras(valor: unknown): { ok: true; regras: RegrasDoBonus } | { ok: false; erro: string } {
  const r = regrasSchema.safeParse(valor ?? {});
  if (r.success) return { ok: true, regras: r.data };
  return { ok: false, erro: r.error.issues[0]?.path.join(".") || "regras" };
}
