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
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
    /** A lista COMPLETA, na ordem; `[]` tira todas. */
    media_item_ids: idsDeMidiaSchema,
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
