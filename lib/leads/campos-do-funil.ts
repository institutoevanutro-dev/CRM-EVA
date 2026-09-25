import type { SupabaseClient } from "@supabase/supabase-js";

import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

/** Lê `pipelines.settings.fields` sem explodir se o jsonb estiver velho ou vazio. */
export function camposDoFunil(settings: Record<string, unknown> | null | undefined): CustomFieldDef[] {
  if (!settings) return [];
  const raw = settings.fields;
  if (!Array.isArray(raw)) return [];
  const out: CustomFieldDef[] = [];
  for (const item of raw) {
    const parsed = customFieldSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * O embed `crm_pipelines(settings)` do PostgREST vem objeto (FK to-one) ou,
 * se a relação vacilar, array. Os dois caem aqui — lixo vira `null`.
 */
export function settingsDoEmbed(embed: unknown): Record<string, unknown> | null {
  const alvo = Array.isArray(embed) ? embed[0] : embed;
  if (!alvo || typeof alvo !== "object") return null;
  const settings = (alvo as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return settings as Record<string, unknown>;
}


/** Campo `select` com opções: o que a Origem padrão de um canal pode usar. */
export interface CampoDeLista {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

/**
 * Os campos `select` (com opções) do funil padrão da org. Fonte ÚNICA da tela
 * (o que se oferece) e da rota (o que se aceita): as duas não podem divergir.
 * Erro de consulta sobe.
 */
export async function camposDeListaDoFunilPadrao(
  db: SupabaseClient,
  organizationId: string,
): Promise<CampoDeLista[]> {
  const { data, error } = await db
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return camposDoFunil((data as { settings: Record<string, unknown> | null } | null)?.settings)
    .filter((c) => c.type === "select" && (c.options?.length ?? 0) > 0)
    .map((c) => ({ key: c.key, label: c.label, options: c.options ?? [] }));
}

/** O par `{campo, valor}` existe no funil padrão (campo `select` e valor entre as opções)? */
export function origemValida(campos: CampoDeLista[], origem: { campo: string; valor: string }): boolean {
  const campo = campos.find((c) => c.key === origem.campo);
  return !!campo && campo.options.some((o) => o.value === origem.valor);
}
