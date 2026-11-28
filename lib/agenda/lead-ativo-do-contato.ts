import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

/**
 * O negócio ativo do contato, onde as atividades da agenda ancoram, pela MESMA
 * régua do resto do produto.
 *
 * `resolveActiveLeadForContact` distingue três desfechos que um `limit(2)` não
 * distingue: roteou, `no_open_lead` e `ambiguous_open_leads`. Os dois últimos
 * NÃO são erro: o agendamento existe e a atividade não nasce, porque não há
 * negócio a que ancorar.
 *
 * Usada pelo handler da agenda e pela confirmação do paciente
 * (`confirmacao-do-lembrete.ts`).
 */
export async function leadAtivoDoContato(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  const [{ data: candidatos }, { data: padrao }] = await Promise.all([
    db
      .from("crm_leads")
      .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId),
    db
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("is_default", true)
      .eq("is_archived", false)
      .maybeSingle(),
  ]);

  const rota = resolveActiveLeadForContact((candidatos ?? []) as LeadCandidate[], {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });
  return rota.routed ? rota.leadId : null;
}
