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
