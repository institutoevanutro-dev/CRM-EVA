import { z } from "zod";

import { hojeNaClinica, type Variante } from "@/lib/midias/termo";

const data = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.")
  // "2026-13-45" passa no formato e o Postgres a recusaria (500): exige data de calendário real.
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Data inexistente.");
const etiquetas = z.array(z.string().trim().min(1).max(40)).max(20);

export const variantesSchema = z
  .array(
    z.object({
      key: z.enum(["A", "B"]),
      storage_path: z.string().min(1),
      mime: z.string().min(1),
      size_bytes: z.number().int().positive(),
    }),
  )
  .max(2)
  .refine((vs) => new Set(vs.map((v) => v.key)).size === vs.length, "Variante repetida.");

/**
 * Variantes de uma linha, já FILTRADAS: a RLS deixa um manager gravar `variants`
 * direto pela REST, e as rotas usam o client admin sobre o caminho. Só vale
 * caminho `<org>/<item>/<arquivo>` — nunca o arquivo de outra organização.
 */
export function variantesDoItem(bruto: unknown, orgId: string, itemId: string): Variante[] {
  const r = variantesSchema.safeParse(bruto);
  if (!r.success) return [];
  const prefixo = `${orgId}/${itemId}/`;
  return r.data.filter((v) => {
    if (!v.storage_path.startsWith(prefixo)) return false;
    const resto = v.storage_path.slice(prefixo.length);
    return /^[A-Za-z0-9._-]+$/.test(resto) && resto !== "." && resto !== "..";
  });
}

export const criarMidiaSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    when_to_use: z.string().trim().max(500).optional(),
    tags: etiquetas.optional(),
    contains_person: z.boolean().optional(),
  })
  .strict();

export const editarMidiaSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    when_to_use: z.string().trim().max(500).optional(),
    tags: etiquetas.optional(),
    contains_person: z.boolean().optional(),
    consent: z
      .object({
        subject: z.string().trim().min(1).max(120),
        scope: z.string().trim().min(1).max(200),
        signed_at: data,
        expires_at: data.nullable(),
      })
      .strict()
      .refine((c) => c.signed_at <= hojeNaClinica(), "A data de assinatura não pode ser no futuro.")
      .refine((c) => c.expires_at === null || c.expires_at >= c.signed_at, "A validade não pode ser antes da assinatura.")
      .optional(),
    revogar: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar.")
  .refine((v) => !(v.consent && v.revogar), "Registrar termo e revogar são pedidos separados.");

export type CriarMidia = z.infer<typeof criarMidiaSchema>;
export type EditarMidia = z.infer<typeof editarMidiaSchema>;
