import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

/**
 * A senha só é reserva para quem está ligado à Conta EvaLink.
 *
 * Chamador já confere `configEvalink()` antes de chamar isto (esta função não
 * decide se o EvaLink está ligado, só a regra de quem pode usar senha).
 *
 * true = bloqueia a senha. Bloqueia quando a pessoa tem vínculo em
 * `evalink_vinculos` e NÃO é admin ativo em nenhuma organização nem platform
 * admin ativo.
 *
 * Falha FECHADA: erro em qualquer uma das três leituras devolve `true`
 * (bloqueia) em vez de deixar passar por incerteza. Uma leitura que falhou não
 * prova que a pessoa é admin.
 */
export async function reservaBloqueia(admin: SupabaseClient, userId: string): Promise<boolean> {
  const vinculo = await admin
    .from("evalink_vinculos")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (vinculo.error) {
    logger.error("evalink_reserva_consulta_falhou", { tabela: "evalink_vinculos" });
    return true;
  }
  if (!vinculo.data) return false;

  const [orgAdmin, platformAdmin] = await Promise.all([
    admin
      .from("user_organizations")
      .select("id")
      .eq("user_id", userId)
      .eq("role", "admin")
      .is("revoked_at", null)
      .limit(1),
    admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  if (orgAdmin.error) {
    logger.error("evalink_reserva_consulta_falhou", { tabela: "user_organizations" });
    return true;
  }
  if (platformAdmin.error) {
    logger.error("evalink_reserva_consulta_falhou", { tabela: "platform_admins" });
    return true;
  }

  const ehAdmin = (orgAdmin.data?.length ?? 0) > 0 || Boolean(platformAdmin.data);
  return !ehAdmin;
}
