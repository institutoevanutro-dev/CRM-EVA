/**
 * Id estrangeiro vindo do corpo é desta organização? (B4 da auditoria de
 * 2026-09-29.)
 *
 * A FK confere que o id EXISTE, não que é da MESMA organização, e o service
 * role não tem RLS para segurar. Sem esta conferência, a linha da org A aponta
 * para a credencial/contato/agente da org B — e o `on delete restrict` impede B
 * de apagar o que é dela. A recusa é 422 sem dizer se o id existe em outro
 * lugar: "não é desta organização" e "não existe" são a mesma resposta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type TabelaDaOrg =
  | "ai_agents"
  | "ai_provider_credentials"
  | "channel_sessions"
  | "contacts"
  | "conversations"
  | "crm_leads";

/**
 * Os ids (nulos ignorados) que NÃO existem nesta organização. `null` quando a
 * consulta falhou: sem conferir não se grava, e o chamador responde 500.
 */
export async function idsForaDaOrg(
  db: Pick<SupabaseClient, "from">,
  orgId: string,
  tabela: TabelaDaOrg,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<string[] | null> {
  const alvo = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (alvo.length === 0) return [];
  const { data, error } = await db.from(tabela).select("id").eq("organization_id", orgId).in("id", alvo);
  if (error) return null;
  const achados = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  return alvo.filter((id) => !achados.has(id));
}
