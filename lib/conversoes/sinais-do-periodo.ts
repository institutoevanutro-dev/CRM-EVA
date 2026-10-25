/**
 * Os NEGÓCIOS que entraram, no período, numa etapa marcada como sinal pago em
 * Configurações › Conversões. Uma régua só para o funil por origem e para o
 * bônus da equipe: `lead.stage_changed` no `event_log`, um por negócio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGINA = 1000;

export async function leadsQueEntraramNoSinal(
  admin: SupabaseClient,
  org: string,
  etapas: readonly string[],
  inicioISO: string,
  fimISO: string,
): Promise<string[]> {
  if (etapas.length === 0) return [];
  const ids = new Set<string>();
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await admin
      .from("event_log")
      .select("entity_id")
      .eq("organization_id", org)
      .eq("event_type", "lead.stage_changed")
      .in("payload->>to_stage_id", [...etapas])
      .gte("created_at", inicioISO)
      .lt("created_at", fimISO)
      .order("id")
      .range(de, de + PAGINA - 1);
    if (error) throw new Error("sinais_do_periodo: leitura falhou");
    for (const linha of (data ?? []) as { entity_id: string | null }[]) if (linha.entity_id) ids.add(linha.entity_id);
    if (!data || data.length < PAGINA) return [...ids];
  }
}
