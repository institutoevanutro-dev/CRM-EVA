/**
 * DE QUEM a tela da Agenda pergunta a ocupação do Google.
 *
 * Porte de melgarafael/DeskcommCRM 42c558397 (issue #896, item 3), com a regra
 * do Prestador que só este fork tem.
 *
 * A ocupação é lida por DONO (`fn_agenda_ocupacao_google_do_dono`, migration
 * 0260) porque é isso que a função `security definer` sabe responder: `p_owner`
 * é quem manda. Quem chama precisa saber QUEM perguntar — e a lista não pode
 * vir da sessão: a RLS de `user_organizations` só entrega o PRÓPRIO membership
 * a `viewer`, `provider` e `agent`. Por isso o client admin, com
 * `organization_id` de fonte confiável (cookie validado, resolvido por quem
 * chama) como filtro EXPLÍCITO. Sem service role, degrada para a sessão: a tela
 * mostra a ocupação de quem ela enxerga em vez de não mostrar nada.
 *
 * O PRESTADOR trabalha só na própria agenda: a RLS de `calendar_appointments`
 * esconde dele os compromissos dos colegas. A função do dono atende a todo
 * membro, então o alcance dele é decidido AQUI — só ele mesmo. Sem esta linha a
 * grade dele desenharia "Ocupado" na agenda de quem ele não enxerga.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function donosDaAgenda(
  organizationId: string,
  quemOlha: { id: string; papel: string },
): Promise<{ donos: string[]; erro: string | null }> {
  if (quemOlha.papel === "provider") return { donos: [quemOlha.id], erro: null };

  const client = isServiceRoleConfigured() ? createAdminClient() : await createClient();
  const { data, error } = await client
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    // Revogado não tem agenda viva: perguntar por ele gastaria uma chamada por
    // pessoa que não aparece em coluna nenhuma.
    .is("revoked_at", null);

  // Vazio é resposta legítima; erro devolve lista vazia COM a mensagem, para o
  // log de quem chamou contar o que houve.
  if (error) return { donos: [], erro: error.message };
  return { donos: (data ?? []).map((linha) => linha.user_id as string), erro: null };
}
