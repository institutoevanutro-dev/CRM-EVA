/**
 * `GET`/`PUT /api/v1/comentarios/regra-do-rqe`: a regra do RQE dos comentários
 * do Instagram desta organização (`settings.medico_sem_rqe`, migration 0381).
 *
 * Ligada (o padrão, e o valor de quem nunca mexeu), a IA nunca chama ninguém de
 * especialista ou nutrólogo, e comentário sobre especialidade espera um humano.
 * Quem aplica a regra é `lib/comentarios/regra-do-rqe.ts`, lida pelo worker e
 * pelas rotas de publicar e de vocabulário.
 *
 * Ler é `agent`, como as frases do Direct. Mudar é `admin`: a regra decide o que
 * sai em público assinado pelo dono do perfil. A escrita vai pela função
 * `fn_definir_medico_sem_rqe` com o client da SESSÃO, e não pela chave de
 * serviço: é o `auth.uid()` que faz o banco conferir papel, suporte e MFA de
 * novo, e a gravação é um comando só, sem ler e regravar o jsonb.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { medicoSemRqe } from "@/lib/comentarios/regra-do-rqe";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ ligada: z.boolean() });

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "instagram_comment_regra_do_rqe" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();

  // Aqui a falha NÃO vira "ligada": a tela mostraria uma chave que pode estar
  // mentindo. Quem degrada para ligada é a leitura dos pontos que aplicam a regra.
  if (error) {
    logger.error("[comentarios.regra-do-rqe] leitura falhou", { erro: error.message, requestId });
    return fail("db_error", traduzir("Não foi possível ler a regra.", authz.user.idioma), 500, { requestId });
  }

  return ok({ ligada: medicoSemRqe((data as { settings?: unknown } | null)?.settings) }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "instagram_comment_regra_do_rqe" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_definir_medico_sem_rqe", {
    p_organization_id: org.orgId,
    p_ligada: parsed.data.ligada,
  });

  if (error) {
    // 42501 é a recusa da própria função: papel, suporte ou MFA conferidos de
    // novo no banco. Nada foi gravado, e nada se audita.
    if (error.code === "42501") {
      return error.message.includes("mfa_required")
        ? fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId })
        : fail("forbidden_role", t("Só um administrador pode mudar esta regra."), 403, { requestId });
    }
    if (error.code === "P0002") {
      return fail("not_found", t("Organização não encontrada."), 404, { requestId });
    }
    logger.error("[comentarios.regra-do-rqe] gravação falhou", {
      erro: error.message,
      requestId,
      organizationId: org.orgId,
    });
    return fail("db_error", t("Não foi possível salvar a regra."), 500, { requestId });
  }

  await audit({
    action: "comment.regra_do_rqe_alterada",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: { ligada: parsed.data.ligada },
  });

  return ok({ ligada: parsed.data.ligada }, { requestId });
}
