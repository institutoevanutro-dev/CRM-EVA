import { z } from "zod";

import { idsDeMidiaSchema } from "@/lib/templates/midias";

export const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4096),
  shortcut: z.string().trim().min(1).max(40).optional(),
  /** true = compartilhado da org (owner null, exige manager+); false = pessoal. */
  shared: z.boolean().default(false),
  /** Itens da Biblioteca de mídia, na ordem em que saem (migration 0383). */
  media_item_ids: idsDeMidiaSchema.optional(),
  /**
   * "Mostrar na barra do Inbox" (migration 0398). Ausente = LIGADO: a resposta
   * nasce aparecendo na barra, como sempre. A tela manda `false` só quando o
   * operador desmarca.
   */
  mostrar_na_barra: z.boolean().optional(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
    /** A lista COMPLETA, na ordem; `[]` tira todas. */
    media_item_ids: idsDeMidiaSchema,
    /** "Mostrar na barra do Inbox" (migration 0398) — o liga/desliga da tela. */
    mostrar_na_barra: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

/**
 * A REORDENAÇÃO (porte do original #3261): onde a resposta rápida foi solta.
 *
 * `depois_de` é o id do vizinho da ESQUERDA; `null` é a primeira posição. A tela
 * manda o VIZINHO, nunca um número: a posição é conta do servidor
 * (`lib/templates/ordem.ts`). Não é `.uuid()` de propósito: quem valida a posse
 * é a lista visível da organização, e a recusa de lá diz o motivo certo.
 */
export const moverTemplateSchema = z.object({
  depois_de: z.string().trim().min(1).max(64).nullable(),
});
export type MoverTemplateInput = z.infer<typeof moverTemplateSchema>;
