/**
 * QUEM PODE SER RESPONSÁVEL POR UMA TAREFA — membro ativo da própria clínica.
 *
 * `crm_tasks.assigned_to` referencia `auth.users`, não a organização. Sem esta
 * conferência, um POST com o id de um usuário de OUTRA organização gravava, e
 * a tarefa aparecia no Início dele. O conjunto é o mesmo que a tela oferece
 * (`/api/v1/team/assignable`): ativo e acima de visualizador.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export async function responsavelValido(
  db: Pick<SupabaseClient, "from">,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .neq("role", "viewer")
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

/**
 * O cliente que ENXERGA a equipe: a RLS de `user_organizations` só mostra a um
 * `agent` o próprio vínculo, então com a service role configurada a leitura vai
 * pelo admin — filtrada pela org resolvida no `requireRole`, nunca pelo body.
 * Sem service role, cai na sessão (e um agent só consegue atribuir a si).
 */
export function clienteDaEquipe(sessao: Pick<SupabaseClient, "from">): Pick<SupabaseClient, "from"> {
  return isServiceRoleConfigured() ? createAdminClient() : sessao;
}
